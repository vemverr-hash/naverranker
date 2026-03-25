const { chromium } = require("playwright");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// 동시 실행 수 (브라우저 탭 수)
const CONCURRENCY = 3;

// 딜레이 설정 (초)
const DELAY_BETWEEN_PAGES = { min: 1.5, max: 3 };

function delay(config) {
  const ms = (config.min + Math.random() * (config.max - config.min)) * 1000;
  return new Promise((r) => setTimeout(r, ms));
}

function extractDomain(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

async function fetchPage(page, keyword, startNum) {
  const url = `https://m.search.naver.com/search.naver?where=m_web&query=${encodeURIComponent(keyword)}&start=${startNum}`;

  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(800);

  const results = await page.evaluate(() => {
    const items = [];
    const seen = new Set();
    const links = document.querySelectorAll("a");

    for (const a of links) {
      const href = a.href || "";
      const text = (a.textContent || "").trim();

      if (
        href && href.startsWith("http") &&
        text.length >= 5 && text.length <= 200 &&
        !href.includes("naver.com") && !href.includes("pstatic.net") &&
        !href.includes("ader.naver") && !href.includes("openstreetmap") &&
        !seen.has(href)
      ) {
        seen.add(href);
        items.push({ title: text.substring(0, 200), link: href });
      }
    }
    return items;
  });

  return results;
}

async function searchMobileNaver(page, keyword) {
  const allResults = [];
  const seenLinks = new Set();
  const maxPages = 15;

  for (let p = 0; p < maxPages; p++) {
    const startNum = p * 10 + 1;

    try {
      const results = await fetchPage(page, keyword, startNum);
      let newCount = 0;
      for (const r of results) {
        if (!seenLinks.has(r.link)) {
          seenLinks.add(r.link);
          allResults.push(r);
          newCount++;
        }
      }
      if (newCount === 0 && p > 0) break;
    } catch (err) {
      console.error(`  [${keyword}] 페이지 ${p + 1} 오류: ${err.message}`);
      break;
    }

    await delay(DELAY_BETWEEN_PAGES);
  }

  return allResults;
}

function findSiteRank(results, site) {
  const domain = site.toLowerCase().replace(/^www\./, "");
  for (let i = 0; i < results.length; i++) {
    const rd = extractDomain(results[i].link);
    if (rd === domain || rd.endsWith("." + domain)) {
      return { rank: i + 1, title: results[i].title, link: results[i].link };
    }
  }
  return { rank: null, title: "", link: "" };
}

// 키워드 1개를 처리하는 워커
async function processKeyword(context, keyword) {
  const page = await context.newPage();
  console.log(`  🔍 시작: "${keyword}"`);

  try {
    const results = await searchMobileNaver(page, keyword);
    console.log(`  ✅ "${keyword}" → ${results.length}개 결과`);
    return { keyword, results };
  } catch (err) {
    console.error(`  ❌ "${keyword}" 실패: ${err.message}`);
    return { keyword, results: [] };
  } finally {
    await page.close();
  }
}

// 병렬 실행 (최대 CONCURRENCY개씩)
async function runParallel(context, uniqueKeywords) {
  const searchCache = {};
  
  // CONCURRENCY개씩 묶어서 동시 실행
  for (let i = 0; i < uniqueKeywords.length; i += CONCURRENCY) {
    const batch = uniqueKeywords.slice(i, i + CONCURRENCY);
    console.log(`\n--- 배치 ${Math.floor(i / CONCURRENCY) + 1}: ${batch.map(k => `"${k}"`).join(", ")} ---`);

    const promises = batch.map((kw) => processKeyword(context, kw));
    const results = await Promise.all(promises);

    for (const { keyword, results: r } of results) {
      searchCache[keyword] = r;
    }

    // 배치 간 딜레이 (차단 방지)
    if (i + CONCURRENCY < uniqueKeywords.length) {
      console.log(`  ⏳ 다음 배치 대기 중...`);
      await delay({ min: 3, max: 5 });
    }
  }

  return searchCache;
}

async function main() {
  const startTime = Date.now();
  console.log("====================================");
  console.log("네이버 모바일 순위 체크 (병렬)", new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }));
  console.log(`동시 실행: ${CONCURRENCY}개 | 최대 15페이지(150위)`);
  console.log("====================================\n");

  const { data: keywords, error } = await supabase
    .from("keywords").select("*").order("id", { ascending: true });

  if (error) { console.error("DB 오류:", error.message); return; }
  if (!keywords || keywords.length === 0) { console.log("키워드 없음"); return; }

  console.log(`키워드: ${keywords.length}개\n`);

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Linux; Android 13; SM-S908B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
    viewport: { width: 412, height: 915 },
    locale: "ko-KR",
  });

  // 같은 키워드는 한 번만 검색
  const uniqueKeywords = [...new Set(keywords.map((k) => k.keyword))];
  console.log(`고유 키워드: ${uniqueKeywords.length}개`);

  // 병렬 실행
  const searchCache = await runParallel(context, uniqueKeywords);

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

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  console.log(`\n⏱ 총 소요 시간: ${elapsed}초`);
  console.log("완료:", new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }));
}

main().catch(console.error);
