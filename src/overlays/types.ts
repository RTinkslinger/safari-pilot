export type OverlayCategory =
  | 'cookie-consent'
  | 'registration-wall'
  | 'app-install'
  | 'paywall';

export type SignalType =
  | 'selector'
  | 'aria-label-substring'
  | 'aria-role'
  | 'fixed-position'
  | 'z-index-above';

export interface PatternSignal {
  type: SignalType;
  value: string;
  caseInsensitive?: boolean;
}

export interface DismissAction {
  action: 'click' | 'esc-key' | 'remove-node';
  selector?: string;
  fallbackAction?: 'click' | 'esc-key' | 'remove-node';
  fallbackSelector?: string;
}

export interface VerifySpec {
  type: 'node-removed';
  stabilityMs: number;
}

export interface OverlayPattern {
  id: string;
  signals: PatternSignal[];
  dismiss: DismissAction;
  verify: VerifySpec;
  notes?: string;
}

export interface AllowlistFile {
  version: number;
  category: OverlayCategory;
  patterns: OverlayPattern[];
}

export interface PatternRegistryEntry extends OverlayPattern {
  category: OverlayCategory;
  fileVersion: number;
}
