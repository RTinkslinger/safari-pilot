import { describe, it, expect } from 'vitest';

describe('safari_click download context', () => {
  it('extracts href from clicked <a> element', () => {
    const jsResult = {
      clicked: true,
      element: { tagName: 'A', id: 'dl-link', textContent: 'Download' },
      downloadContext: {
        href: 'https://example.com/file.pdf',
        downloadAttr: null,
        isDownloadLink: false,
      },
    };
    expect(jsResult.downloadContext).toBeDefined();
    expect(jsResult.downloadContext!.href).toBe('https://example.com/file.pdf');
  });

  it('extracts download attribute from <a download="name.pdf">', () => {
    const jsResult = {
      clicked: true,
      element: { tagName: 'A', id: 'dl-link', textContent: 'Download' },
      downloadContext: {
        href: 'https://example.com/file.pdf',
        downloadAttr: 'report.pdf',
        isDownloadLink: true,
      },
    };
    expect(jsResult.downloadContext!.downloadAttr).toBe('report.pdf');
    expect(jsResult.downloadContext!.isDownloadLink).toBe(true);
  });

  it('returns undefined downloadContext when element is not inside an <a>', () => {
    const jsResult = {
      clicked: true,
      element: { tagName: 'BUTTON', id: 'btn', textContent: 'Submit' },
      downloadContext: undefined,
    };
    expect(jsResult.downloadContext).toBeUndefined();
  });
});
