import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { CURRENCY_CODES } from '@anton/shared';

const brandSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 140 },
    websiteUrl: { type: String, default: null },
    logoImageKey: { type: String, default: null },
    primaryColorHex: { type: String, default: null, match: /^#[0-9a-fA-F]{6}$/ },
    contactEmail: { type: String, default: null, lowercase: true, trim: true },
    country: { type: String, default: null, maxlength: 2 },
    defaultCurrency: { type: String, required: true, enum: CURRENCY_CODES, default: 'GBP' },
  },
  { timestamps: true, collection: 'brands' },
);

brandSchema.index({ name: 1 }, { unique: true });

export type BrandDoc = InferSchemaType<typeof brandSchema>;
export const BrandModel: Model<BrandDoc> = model<BrandDoc>('Brand', brandSchema);
