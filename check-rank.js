const { chromium } = require("playwright");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

function randomDelay() {
  const ms = 2000 + Math.random() * 2000;
  return new Promise((r) => setTimeout(r, ms));
}

function extractDomain(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

// 모바일 네이버 웹 탭에서 검색 결과 추출
async function searchMobileNaver(page, keyword) {
  // 모바일 웹문서 탭 직접 접근
  const url = `https://m.search.naver.com/search.naver?where=m_web&query=${encodeURIComponent(keyword)}`;

  console.log(`  → 웹 탭 로드 중...`);
  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(2000);

  // "더보기" 버튼 반복 클릭해서 결과 더 로드 (최대 10번)
  for (let i = 0; i < 10; i++) {
    try {
      // 스크롤 끝까지
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1000);

      // "더보기" 버튼 찾기
      const moreBtn = await page.$('a.more_btn, a[class*="more"], button[class*="more"]');
      if (moreBtn) {
        await moreBtn.click();
        await page.waitForTimeout(2000);
        console.log(`  → 더보기 클릭 (${i + 1}회)`);
      } else {
        // 페이지 넘기기 링크 찾기
        const nextPage = await page.$('a.page_next, a[class*="next"]');
        if (nextPage) {
          await nextPage.click();
          await page.waitForTimeout(2000);
          console.log(`  → 다음 페이지 (${i + 1}회)`);
        } else {
          break;
        }
      }
    } catch {
      break;
    }
  }

  // 최종 스크롤
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1000);

  // 모든 검색 결과 링크 추출
  const results = await page.evaluate(() => {
    const items = [];
    const seen = new Set();

    // 웹 검색 결과의 제목 링크들
    const links = document.querySelectorAll("a");

    for (const a of links) {
      const href = a.href || "";
      const text = (a.textContent || "").trim();

      // 외부 링크만 (네이버 내부 제외)
      if (
        href &&
        href.startsWith("http") &&
        text.length > 3 &&
        !href.includes("naver.com") &&
        !href.includes("pstatic.net") &&
        !href.includes("ader.naver") &&
        !href.includes("openstreetmap") &&
        !href.includes("google.com") &&
        !href.includes("youtube.com/embed") &&
        !seen.has(href)
      ) {
        // 제목급 텍스트만 (너무 짧거나 너무 긴 건 제외)
        if (text.length >= 5 && text.length <= 200) {
          seen.add(href);
          items.push({
            title: text.substring(0, 200),
            link: href,
          });
        }
      }
    }

    return items;
  });

  return results;
}

// 키워드에 대해 사이트 순위 찾기
function findSiteRank(results, site) {
  const domain = site.toLowerCase().replace(/^www\./, "");

  for (let i = 0; i < results.length; i++) {
    const rd = extractDomain(results[i].link);
    if (rd === domain || rd.endsWith("." + domain)) {
      return {
        rank: i + 1,
        title: results[i].title,
        link: results[i].link,
      };
    }
  }

  return { rank: null, title: "", link: "" };
}

async function main() {
  console.log("====================================");
  console.log("네이버 모바일 순위 체크:", new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }));
  console.log("====================================\n");

  const { data: keywords, error } = await supabase
    .from("keywords")
    .select("*")
    .order("id", { ascending: true });

  if (error) {
    console.error("DB 오류:", error.message);
    return;
  }
  if (!keywords || keywords.length === 0) {
    console.log("키워드 없음");
    return;
  }

  console.log(`키워드: ${keywords.length}개\n`);

  // 브라우저 실행
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Linux; Android 13; SM-S908B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
    viewport: { width: 412, height: 915 },
    locale: "ko-KR",
  });

  const page = await context.newPage();

  // 같은 키워드는 한 번만 검색
  const uniqueKeywords = [...new Set(keywords.map((k) => k.keyword))];
  const searchCache = {};

  for (const kw of uniqueKeywords) {
    console.log(`\n검색: "${kw}"`);
    try {
      searchCache[kw] = await searchMobileNaver(page, kw);
      console.log(`  총 ${searchCache[kw].length}개 결과`);

      // 디버그: 첫 10개 결과
      searchCache[kw].slice(0, 10).forEach((r, i) => {
        console.log(`    ${i + 1}. [${extractDomain(r.link)}] ${r.title.substring(0, 50)}`);
      });
    } catch (err) {
      console.error(`  검색 실패: ${err.message}`);
      searchCache[kw] = [];
    }

    await randomDelay();
  }

  await browser.close();

  // 순위 계산 및 저장
  const now = new Date().toISOString();
  const inserts = [];

  console.log("\n=== 순위 결과 ===");
  for (const kw of keywords) {
    const results = searchCache[kw.keyword] || [];
    const found = findSiteRank(results, kw.site);
    const rankText = found.rank ? `${found.rank}위` : "순위권 밖";
    console.log(`  ${kw.site} | ${kw.keyword} → ${rankText}`);

    inserts.push({
      keyword_id: kw.id,
      rank: found.rank,
      title: found.title,
      link: found.link,
      checked_at: now,
    });
  }

  if (inserts.length > 0) {
    const { error: ie } = await supabase.from("ranks").insert(inserts);
    if (ie) console.error("\n❌ 저장 실패:", ie.message);
    else console.log(`\n✅ ${inserts.length}개 저장 완료`);
  }

  console.log("\n완료:", new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }));
}

main().catch(console.error);
