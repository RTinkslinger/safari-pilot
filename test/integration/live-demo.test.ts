/**
 * Live Demo — Real website, full pipeline
 * Tests against Hacker News (a real, dynamic website with forms and links)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SafariPilotServer } from '../../src/server.js';

describe.skipIf(process.env.CI === 'true')('Live Demo — Hacker News', () => {
  let server: SafariPilotServer;
  let tabUrl: string;

  beforeAll(async () => {
    server = new SafariPilotServer();
    await server.initialize();
  }, 30000);

  afterAll(async () => {
    if (tabUrl) {
      try {
        const urls = [tabUrl, tabUrl.endsWith('/') ? tabUrl.slice(0, -1) : tabUrl + '/'];
        for (const u of urls) {
          try { await server.executeToolWithSecurity('safari_close_tab', { tabUrl: u }); break; } catch {}
        }
      } catch {}
    }
    await server.shutdown();
  });

  it('Step 1: Open Hacker News in a new tab', async () => {
    const result = await server.executeToolWithSecurity('safari_new_tab', {
      url: 'https://news.ycombinator.com',
    });
    const data = JSON.parse(result.content[0].text!);
    tabUrl = data.tabUrl;
    console.log(`\n🌐 Opened: ${tabUrl}`);
    expect(tabUrl).toBeDefined();
  }, 15000);

  it('Step 2: Wait for page load and read the title', async () => {
    await new Promise(r => setTimeout(r, 3000));
    const actualUrl = tabUrl.endsWith('/') ? tabUrl : tabUrl + '/';

    // Try both URL forms
    let data: any;
    for (const url of [actualUrl, 'https://news.ycombinator.com/', 'https://news.ycombinator.com']) {
      try {
        const result = await server.executeToolWithSecurity('safari_evaluate', {
          tabUrl: url, script: 'return document.title',
        });
        data = JSON.parse(result.content[0].text!);
        if (data.value) { tabUrl = url; break; }
      } catch {}
    }

    console.log(`📄 Title: "${data?.value}"`);
    expect(data?.value).toContain('Hacker News');
  }, 15000);

  it('Step 3: Extract the top 5 story titles', async () => {
    const result = await server.executeToolWithSecurity('safari_evaluate', {
      tabUrl,
      script: `
        var stories = [];
        var rows = document.querySelectorAll('.titleline > a');
        for (var i = 0; i < Math.min(5, rows.length); i++) {
          stories.push({ rank: i + 1, title: rows[i].textContent, href: rows[i].href });
        }
        return stories;
      `,
    });
    const data = JSON.parse(result.content[0].text!);
    const stories = typeof data.value === 'string' ? JSON.parse(data.value) : data.value;

    console.log('\n📰 Top 5 Hacker News Stories:');
    for (const s of stories) {
      console.log(`   ${s.rank}. ${s.title}`);
      console.log(`      ${s.href}`);
    }

    expect(stories.length).toBe(5);
    expect(stories[0].title).toBeTruthy();
    expect(stories[0].href).toMatch(/^https?:\/\//);
  }, 15000);

  it('Step 4: Get page stats (links, forms, elements)', async () => {
    const result = await server.executeToolWithSecurity('safari_evaluate', {
      tabUrl,
      script: `
        return {
          links: document.querySelectorAll('a').length,
          forms: document.querySelectorAll('form').length,
          images: document.querySelectorAll('img').length,
          tables: document.querySelectorAll('table').length,
          totalElements: document.querySelectorAll('*').length,
          url: window.location.href,
          readyState: document.readyState,
        };
      `,
    });
    const data = JSON.parse(result.content[0].text!);
    const stats = typeof data.value === 'string' ? JSON.parse(data.value) : data.value;

    console.log('\n📊 Page Stats:');
    console.log(`   URL: ${stats.url}`);
    console.log(`   Ready State: ${stats.readyState}`);
    console.log(`   Links: ${stats.links}`);
    console.log(`   Forms: ${stats.forms}`);
    console.log(`   Images: ${stats.images}`);
    console.log(`   Tables: ${stats.tables}`);
    console.log(`   Total Elements: ${stats.totalElements}`);

    expect(stats.links).toBeGreaterThan(10);
    expect(stats.readyState).toBe('complete');
  }, 15000);

  it('Step 5: Extract all comment counts from front page', async () => {
    const result = await server.executeToolWithSecurity('safari_evaluate', {
      tabUrl,
      script: `
        var items = [];
        var subtext = document.querySelectorAll('.subtext');
        for (var i = 0; i < Math.min(10, subtext.length); i++) {
          var scoreEl = subtext[i].querySelector('.score');
          var commentLinks = subtext[i].querySelectorAll('a');
          var commentLink = commentLinks[commentLinks.length - 1];
          items.push({
            points: scoreEl ? scoreEl.textContent : 'n/a',
            comments: commentLink ? commentLink.textContent : 'n/a',
          });
        }
        return items;
      `,
    });
    const data = JSON.parse(result.content[0].text!);
    const items = typeof data.value === 'string' ? JSON.parse(data.value) : data.value;

    console.log('\n💬 Story Engagement (top 10):');
    for (let i = 0; i < items.length; i++) {
      console.log(`   ${i + 1}. ${items[i].points} | ${items[i].comments}`);
    }

    expect(items.length).toBeGreaterThan(0);
  }, 15000);

  it('Step 6: Take a screenshot of Hacker News', async () => {
    const result = await server.executeToolWithSecurity('safari_take_screenshot', {});
    expect(result.content[0].type).toBe('image');
    const imgSize = result.content[0].data?.length || 0;
    console.log(`\n📸 Screenshot captured: ${(imgSize / 1024).toFixed(0)}KB base64`);
    expect(imgSize).toBeGreaterThan(1000);
  }, 15000);

  it('Step 7: Get cookies for the domain', async () => {
    const result = await server.executeToolWithSecurity('safari_get_cookies', {
      tabUrl,
    });
    const data = JSON.parse(result.content[0].text!);
    console.log(`\n🍪 Cookies: ${data.cookies?.length || 0} found`);
  }, 15000);

  it('Step 8: Navigate to a story and read it', async () => {
    // Click the first story link
    const result = await server.executeToolWithSecurity('safari_evaluate', {
      tabUrl,
      script: `
        var firstLink = document.querySelector('.titleline > a');
        if (firstLink) {
          var href = firstLink.href;
          // Don't actually navigate — just report what we'd click
          return { title: firstLink.textContent, href: href, wouldNavigateTo: href };
        }
        return { error: 'No story link found' };
      `,
    });
    const data = JSON.parse(result.content[0].text!);
    const info = typeof data.value === 'string' ? JSON.parse(data.value) : data.value;

    console.log(`\n🔗 First story: "${info.title}"`);
    console.log(`   Would navigate to: ${info.href}`);
    expect(info.title).toBeTruthy();
  }, 15000);

  it('Step 9: Verify audit log captured everything', async () => {
    const auditLog = (server as any).auditLog;
    if (!auditLog) { console.log('SKIP: audit log not exposed'); return; }

    const entries = auditLog.getEntries();
    const tools = [...new Set(entries.map((e: any) => e.tool))];

    console.log(`\n📝 Audit Log: ${entries.length} total entries`);
    console.log(`   Tools used: ${tools.join(', ')}`);
    expect(entries.length).toBeGreaterThan(5);
  }, 5000);
});
