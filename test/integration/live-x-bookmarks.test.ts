/**
 * Live Test — X.com Bookmarks (Authenticated Session)
 * Single sequential test — waits for actual tweet elements, not just SPA shell.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { SafariPilotServer } from '../../src/server.js';

describe('Live Test — X.com Bookmarks (Authenticated)', () => {
  let server: SafariPilotServer;
  let tabUrl: string;

  afterAll(async () => {
    if (tabUrl) {
      for (const u of [tabUrl, tabUrl + '/', tabUrl.replace(/\/$/, '')]) {
        try { await server?.executeToolWithSecurity('safari_close_tab', { tabUrl: u }); break; } catch {}
      }
    }
    await server?.shutdown();
  });

  it('opens bookmarks, waits for tweets, extracts content + profiles', async () => {
    server = new SafariPilotServer();
    await server.initialize();

    // 1. Open bookmarks
    const openResult = await server.executeToolWithSecurity('safari_new_tab', {
      url: 'https://x.com/i/bookmarks',
    });
    tabUrl = JSON.parse(openResult.content[0].text!).tabUrl;
    console.log(`Opened: ${tabUrl}`);

    // 2. Wait specifically for [data-testid="tweet"] — NOT cellInnerDiv
    let tweetsFound = 0;
    let resolvedUrl = tabUrl;
    const urlVariants = [tabUrl, 'https://x.com/i/bookmarks', 'https://x.com/i/bookmarks/'];

    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise(r => setTimeout(r, 1000));

      for (const url of urlVariants) {
        try {
          const check = await server.executeToolWithSecurity('safari_evaluate', {
            tabUrl: url,
            script: 'return document.querySelectorAll(\'[data-testid="tweet"]\').length',
          });
          const d = JSON.parse(check.content[0].text!);
          const count = d.value || 0;
          if (count > 0) {
            tweetsFound = count;
            resolvedUrl = url;
            break;
          }
        } catch {}
      }

      if (tweetsFound > 0) {
        console.log(`Tweets appeared after ${attempt + 1}s: ${tweetsFound} found`);
        break;
      }
      if (attempt % 5 === 4) console.log(`  Still waiting... ${attempt + 1}s`);
    }

    expect(tweetsFound).toBeGreaterThan(0);
    tabUrl = resolvedUrl;

    // 3. Extract bookmarks
    const result = await server.executeToolWithSecurity('safari_evaluate', {
      tabUrl,
      script: `
        var tweetEls = document.querySelectorAll('[data-testid="tweet"]');
        var bookmarks = [];
        for (var i = 0; i < Math.min(5, tweetEls.length); i++) {
          var el = tweetEls[i];
          var textEl = el.querySelector('[data-testid="tweetText"]');
          var text = textEl ? textEl.innerText : '(media/image post)';
          var allLinks = el.querySelectorAll('a[href]');
          var handle = '', profileLink = '', authorName = '';
          for (var j = 0; j < allLinks.length; j++) {
            var href = allLinks[j].getAttribute('href') || '';
            if (href.match(/^\\/[a-zA-Z0-9_]{1,15}$/) && !href.startsWith('/i/') && !href.startsWith('/search') && !href.startsWith('/home') && !href.startsWith('/compose') && !href.startsWith('/notifications')) {
              handle = '@' + href.slice(1);
              profileLink = 'https://x.com' + href;
              var nameContainer = allLinks[j].closest('[data-testid="User-Name"]');
              if (nameContainer) {
                var spans = nameContainer.querySelectorAll('span');
                for (var k = 0; k < spans.length; k++) {
                  var st = spans[k].textContent || '';
                  if (st && !st.startsWith('@') && st.length > 1 && st.length < 50) { authorName = st; break; }
                }
              }
              break;
            }
          }
          var timeEl = el.querySelector('time');
          bookmarks.push({
            rank: i + 1,
            author: authorName || '(unknown)',
            handle: handle || '(unknown)',
            profileUrl: profileLink || '(unknown)',
            text: text.substring(0, 280),
            timestamp: timeEl ? timeEl.getAttribute('datetime') : '',
          });
        }
        return bookmarks;
      `,
    });

    const raw = JSON.parse(result.content[0].text!);
    const bookmarks = raw.value || raw;
    const list = typeof bookmarks === 'string' ? JSON.parse(bookmarks) : bookmarks;

    console.log(`\n========== YOUR TOP ${list.length} BOOKMARKS ==========\n`);
    for (const bm of list) {
      console.log(`#${bm.rank} — ${bm.author} (${bm.handle})`);
      console.log(`   Profile: ${bm.profileUrl}`);
      console.log(`   Text: ${bm.text}`);
      console.log(`   Time: ${bm.timestamp}\n`);
    }

    expect(list.length).toBeGreaterThan(0);
    expect(list[0].handle).not.toBe('(unknown)');
    expect(list[0].profileUrl).toContain('x.com');

    // 4. Screenshot
    const ssResult = await server.executeToolWithSecurity('safari_take_screenshot', {});
    console.log(`Screenshot: ${((ssResult.content[0].data?.length || 0) / 1024).toFixed(0)}KB`);
  }, 60000);
});
