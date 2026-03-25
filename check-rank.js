const axios = require("axios");
const cheerio = require("cheerio");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

function randomDelay() {
  const ms = 2000 + Math.random() * 2000;
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchNaverPage(keyword, page, debug = false) {
  const start = (page - 1) * 10 + 1;
  const url = `https://search.naver.com/search.naver?where=webkr&query=${encodeURIComponent(keyword)}&start=${start}`;

  try {
    const res = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      },
      timeout: 10000,
    });

    if (debug) {
      const $ = cheerio.load(res.data);
      console.log(`\n=== 디버그: HTML 길이=${res.data.length} ===`);

      const selectors = [
        ".lst_total .bx", ".total_wrap", ".api_txt_lines.total_tit",
        ".total_tit a", "#main_pack .bx", ".sp_web .bx", "#webkr .bx",
        "ul.lst_total li", ".type01 li",
      ];
      for (const sel of selectors) {
        const count = $(sel).length;
        if (count > 0) console.log(`  셀렉터 "${sel}" → ${count}개`);
      }

      const externalLinks = [];
      $("a").each((i, el) => {
        const href = $(el).attr("href") || "";
        if (href.startsWith("http") && !href.includes("naver.com") && !href.includes("pstatic.net")) {
          const text = $(el).text().trim().substring(0, 50);
          if (text.length > 3) externalLinks.push({ href: href.substring(0, 100), text });
        }
      });
      console.log(`  외부 링크 ${externalLinks.length}개:`);
      externalLinks.slice(0, 10).forEach((l, i) => {
        console.log(`    ${i + 1}. [${l.text}] → ${l.href}`);
      });
    }

    return res.data;
  } catch (err) {
    console.error(`  페이지 ${page} 조회 실패:`, err.message);
    return null;
  }
}

function parseResults(html) {
  const $ = cheerio.load(html);
  const results = [];
  const seen = new Set();

  // 방법 1
  $(".lst_total .bx").each((i, el) => {
    const a = $(el).find(".total_tit a").first();
    const link = a.attr("href") || "";
    const title = a.text().trim();
    if (link && link.startsWith("http") && !seen.has(link)) {
      seen.add(link);
      results.push({ title, link });
    }
  });

  // 방법 2
  if (results.length === 0) {
    $(".total_tit a, a.api_txt_lines.total_tit, a.link_tit").each((i, el) => {
      const link = $(el).attr("href") || "";
      const title = $(el).text().trim();
      if (link && link.startsWith("http") && !link.includes("naver.com") && !seen.has(link)) {
        seen.add(link);
        results.push({ title, link });
      }
    });
  }

  // 방법 3: 모든 외부 링크
  if (results.length === 0) {
    $("a").each((i, el) => {
      const href = $(el).attr("href") || "";
      const text = $(el).text().trim();
      if (
        href.startsWith("http") &&
        !href.includes("naver.com") &&
        !href.includes("pstatic.net") &&
        !href.includes("ader.naver") &&
        text.length > 5 &&
        !seen.has(href)
      ) {
        seen.add(href);
        results.push({ title: text, link: href });
      }
    });
  }

  return results;
}

function extractDomain(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

async function findRank(keyword, site, isFirst = false) {
  const domain = site.toLowerCase().replace(/^www\./, "");
  const maxPages = 15;

  console.log(`  검색: "${keyword}" → ${site}`);

  for (let page = 1; page <= maxPages; page++) {
    const html = await fetchNaverPage(keyword, page, isFirst && page === 1);
    if (!html) break;

    const results = parseResults(html);

    if (isFirst && page === 1) {
      console.log(`  파싱 결과: ${results.length}개`);
      results.slice(0, 5).forEach((r, i) => {
        console.log(`    ${i + 1}. [${extractDomain(r.link)}] ${r.title.substring(0, 40)}`);
      });
    }

    if (results.length === 0 && page > 1) break;

    for (let i = 0; i < results.length; i++) {
      const rd = extractDomain(results[i].link);
      if (rd === domain || rd.endsWith("." + domain)) {
        const rank = (page - 1) * 10 + i + 1;
        console.log(`  ✅ ${rank}위 (page ${page})`);
        return { rank, page, title: results[i].title, link: results[i].link };
      }
    }

    await randomDelay();
  }

  console.log(`  ❌ 순위권 밖`);
  return { rank: null, page: null, title: "", link: "" };
}

async function main() {
  console.log("====================================");
  console.log("네이버 순위 체크:", new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }));
  console.log("====================================\n");

  const { data: keywords, error } = await supabase
    .from("keywords").select("*").order("id", { ascending: true });

  if (error) { console.error("DB 오류:", error.message); return; }
  if (!keywords || keywords.length === 0) { console.log("키워드 없음"); return; }

  console.log(`키워드: ${keywords.length}개\n`);

  const now = new Date().toISOString();
  const inserts = [];

  for (let i = 0; i < keywords.length; i++) {
    const kw = keywords[i];
    try {
      const result = await findRank(kw.keyword, kw.site, i === 0);
      inserts.push({ keyword_id: kw.id, rank: result.rank, title: result.title, link: result.link, checked_at: now });
    } catch (err) {
      console.error(`  오류:`, err.message);
      inserts.push({ keyword_id: kw.id, rank: null, title: "", link: "", checked_at: now });
    }
    if (i < keywords.length - 1) await randomDelay();
  }

  if (inserts.length > 0) {
    const { error: ie } = await supabase.from("ranks").insert(inserts);
    if (ie) console.error("저장 실패:", ie.message);
    else console.log(`\n✅ ${inserts.length}개 저장 완료`);
  }

  console.log("\n=== 결과 ===");
  for (const item of inserts) {
    const kw = keywords.find((k) => k.id === item.keyword_id);
    console.log(`  ${kw?.site} | ${kw?.keyword} → ${item.rank ? item.rank + "위" : "순위권 밖"}`);
  }
}

main().catch(console.error);
