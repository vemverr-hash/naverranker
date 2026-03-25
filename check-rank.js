const { chromium } = require("playwright");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// 딜레이 설정 (초)
const DELAY_BETWEEN_PAGES = { min: 2, max: 4 };     // 페이지 간
const DELAY_BETWEEN_KEYWORDS = { min: 3, max: 5 };  // 키워드 간

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
  await page.waitForTimeout(2000);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1000);

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
      console.error(`  페이지 ${p + 1} 오류: ${err.message}`);
      break;
    }

    // 페이지 간 딜레이
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

async function main() {
  console.log("====================================");
  console.log("네이버 모바일 순위 체크:", new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }));
  console.log(`딜레이: 페이지 간 ${DELAY_BETWEEN_PAGES.min}-${DELAY_BETWEEN_PAGES.max}초, 키워드 간 ${DELAY_BETWEEN_KEYWORDS.min}-${DELAY_BETWEEN_KEYWORDS.max}초`);
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

  const page = await context.newPage();
  const uniqueKeywords = [...new Set(keywords.map((k) => k.keyword))];
  const searchCache = {};

  for (let i = 0; i < uniqueKeywords.length; i++) {
    const kw = uniqueKeywords[i];
    console.log(`[${i + 1}/${uniqueKeywords.length}] 검색: "${kw}"`);

    try {
      searchCache[kw] = await searchMobileNaver(page, kw);
      console.log(`  ✅ ${searchCache[kw].length}개 결과\n`);
    } catch (err) {
      console.error(`  실패: ${err.message}\n`);
      searchCache[kw] = [];
    }

    // 키워드 간 딜레이 (마지막 키워드 제외)
    if (i < uniqueKeywords.length - 1) {
      console.log(`  ⏳ 다음 키워드까지 대기 중...\n`);
      await delay(DELAY_BETWEEN_KEYWORDS);
    }
  }

  await browser.close();

  const now = new Date().toISOString();
  const inserts = [];

  console.log("=== 순위 결과 ===");
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
