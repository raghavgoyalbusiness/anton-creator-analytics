import type { CurrencyCode, IsoCountryCode } from './common.js';

export interface Brand {
  readonly id: string;
  readonly name: string;
  readonly websiteUrl: string | null;
  readonly logoImageKey: string | null;
  /** Hex, used to theme the brand-facing share view. */
  readonly primaryColorHex: string | null;
  readonly contactEmail: string | null;
  readonly country: IsoCountryCode | null;
  readonly defaultCurrency: CurrencyCode;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
