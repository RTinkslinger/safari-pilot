import { ScreenshotBlockedError } from '../errors.js';

const BANKING_DOMAIN_SEED: RegExp[] = [
  /(^|\.)bank\./i,
  /(^|\.)chase\.com$/i,
  /(^|\.)paypal\.com$/i,
  /(^|\.)wellsfargo\.com$/i,
  /(^|\.)bankofamerica\.com$/i,
  /(^|\.)citibank\.com$/i,
  /(^|\.)hsbc\.com$/i,
  /(^|\.)barclays\.com$/i,
  /(^|\.)stripe\.com$/i,
  /(^|\.)venmo\.com$/i,
];

export class ScreenshotPolicy {
  private readonly patterns: RegExp[];

  constructor(config?: { blockedPatterns?: string[] }) {
    if (config?.blockedPatterns !== undefined) {
      this.patterns = config.blockedPatterns.map((p) => new RegExp(p, 'i'));
    } else {
      this.patterns = BANKING_DOMAIN_SEED;
    }
  }

  checkDomain(url: string): void {
    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      return;
    }
    if (this.patterns.find((p) => p.test(hostname))) {
      throw new ScreenshotBlockedError(hostname);
    }
  }
}
