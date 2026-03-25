const axios = require("axios");
const cheerio = require("cheerio");
const { createClient } = require("@supabase/supabase-js");

// Supabase 연결
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// 랜덤 대기 (2~4초)
function randomDelay() {
  const ms = 2000 + Math.random() * 2000;
  return new Promise((r) => setTimeout(r, ms));
}

// 네이버 웹검색 결과 1페이지 가져오기 (10개씩)
async function fetchNaverPage(keyword, page) {
  const start = (page - 1) * 10 + 1;
  const url = `https://search.naver.com/search.naver?where=webkr&query=${encodeURIComponent(keyword)}&start=${start}`;

  try {
    const res = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      },
      timeout: 10000,
    });
    return res.data;
  } catch (err) {
    console.error(`  페이지 ${page} 조회 실패:`, err.message);
    return null;
  }
}

// HTML에서 검색 결과 링크 추출
function parseResults(html) {
  const $ = cheerio.load(html);
  const results = [];

  // 네이버 웹검색 결과의 각 항목
  $(".lst_total .bx").each((i, el) => {
    const titleEl = $(el).find(".total_tit a").first();
    const link = titleEl.attr("href") || "";
    const title = titleEl.text().trim();
    // 출처 URL 표시 영역
    const sourceEl = $(el).find(".total_source .txt, .total_source a.url").first();
    const source = sourceEl.text().trim();

    if (link) {
      results.push({ title, link, source });
    }
  });

  // 대체 셀렉터 (네이버 HTML 구조 변경 대비)
  if (results.length === 0) {
    $(".api_txt_lines.total_tit").each((i, el) => {
      const a = $(el).is("a") ? $(el) : $(el).find("a").first();
      const link = a.attr("href") || "";
      const title = a.text().trim();
      if (link) {
        results.push({ title, link, source: "" });
      }
    });
  }

  return results;
}

// 도메인 추출
function extractDomain(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

// 특정 키워드에 대해 사이트 순위 찾기 (최대 15페이지 = 150개)
async function findRank(keyword, site) {
  const domain = site.toLowerCase().replace(/^www\./, "");
  const maxPages = 15;

  console.log(`  검색: "${keyword}" → ${site}`);

  for (let page = 1; page <= maxPages; page++) {
    const html = await fetchNaverPage(keyword, page);
    if (!html) break;

    const results = parseResults(html);
    if (results.length === 0 && page > 1) break; // 더 이상 결과 없음

    for (let i = 0; i < results.length; i++) {
      const resultDomain = extractDomain(results[i].link);
      if (resultDomain === domain || resultDomain.endsWith("." + domain)) {
        const rank = (page - 1) * 10 + i + 1;
        console.log(`  ✅ ${rank}위 (page ${page}) | ${results[i].title.substring(0, 40)}`);
        return {
          rank,
          page,
          title: results[i].title,
          link: results[i].link,
        };
      }
    }

    // 차단 방지: 페이지 간 랜덤 대기
    await randomDelay();
  }

  console.log(`  ❌ 순위권 밖 (150위 내 없음)`);
  return { rank: null, page: null, title: "", link: "" };
}

// 메인 실행
async function main() {
  console.log("====================================");
  console.log("네이버 순위 체크 시작:", new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }));
  console.log("====================================\n");

  // DB에서 키워드 가져오기
  const { data: keywords, error } = await supabase
    .from("keywords")
    .select("*")
    .order("id", { ascending: true });

  if (error) {
    console.error("DB 조회 실패:", error.message);
    return;
  }

  if (!keywords || keywords.length === 0) {
    console.log("등록된 키워드가 없습니다.");
    return;
  }

  console.log(`등록된 키워드: ${keywords.length}개\n`);

  const now = new Date().toISOString();
  const inserts = [];

  // 키워드별로 순위 체크
  for (let i = 0; i < keywords.length; i++) {
    const kw = keywords[i];

    try {
      const result = await findRank(kw.keyword, kw.site);

      inserts.push({
        keyword_id: kw.id,
        rank: result.rank,
        title: result.title,
        link: result.link,
        checked_at: now,
      });
    } catch (err) {
      console.error(`  오류: ${kw.keyword} →`, err.message);
      inserts.push({
        keyword_id: kw.id,
        rank: null,
        title: "",
        link: "",
        checked_at: now,
      });
    }

    // 키워드 간 대기 (같은 키워드 재검색 방지)
    if (i < keywords.length - 1) {
      await randomDelay();
    }
  }

  // DB에 저장
  if (inserts.length > 0) {
    const { error: insertError } = await supabase.from("ranks").insert(inserts);

    if (insertError) {
      console.error("\n❌ 저장 실패:", insertError.message);
    } else {
      console.log(`\n✅ ${inserts.length}개 결과 저장 완료`);
    }
  }

  // 결과 요약
  console.log("\n====================================");
  console.log("결과 요약:");
  console.log("====================================");
  for (const item of inserts) {
    const kw = keywords.find((k) => k.id === item.keyword_id);
    const rankText = item.rank ? `${item.rank}위 (p${Math.ceil(item.rank / 10)})` : "순위권 밖";
    console.log(`  ${kw?.site} | ${kw?.keyword} → ${rankText}`);
  }
  console.log("\n완료:", new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }));
}

main().catch(console.error);
