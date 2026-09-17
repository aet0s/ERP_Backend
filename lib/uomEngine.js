'use strict';

/**
 * uomEngine.js
 * Central, extensible Unit of Measurement (UOM) engine.
 *
 * Rules:
 * 1. Supports standardized categories: Count, Mass, Volume, Length, Area, Custom.
 * 2. Permits intra-category conversions where mathematically fixed (e.g., 1 kg = 1000 g).
 * 3. STRICTLY FORBIDS automatic cross-dimensional conversion (e.g. kg -> litre or kg -> pcs).
 *    Cross-dimensional relationships must come from manufacturing formulas or packaging configs.
 */

const UOM_CATEGORIES = {
  COUNT: 'count',
  MASS: 'mass',
  VOLUME: 'volume',
  LENGTH: 'length',
  AREA: 'area',
  CUSTOM: 'custom'
};

const STANDARD_UOMS = [
  // Count
  { code: 'pcs', name: 'Pieces', category: UOM_CATEGORIES.COUNT, baseMultiplier: 1 },
  { code: 'unit', name: 'Units', category: UOM_CATEGORIES.COUNT, baseMultiplier: 1 },
  { code: 'nos', name: 'Numbers', category: UOM_CATEGORIES.COUNT, baseMultiplier: 1 },
  { code: 'tablet', name: 'Tablets', category: UOM_CATEGORIES.COUNT, baseMultiplier: 1 },
  { code: 'capsule', name: 'Capsules', category: UOM_CATEGORIES.COUNT, baseMultiplier: 1 },
  { code: 'bottle', name: 'Bottles', category: UOM_CATEGORIES.COUNT, baseMultiplier: 1 },
  { code: 'strip', name: 'Strips', category: UOM_CATEGORIES.COUNT, baseMultiplier: 1 },
  { code: 'pack', name: 'Packs', category: UOM_CATEGORIES.COUNT, baseMultiplier: 1 },
  { code: 'packet', name: 'Packets', category: UOM_CATEGORIES.COUNT, baseMultiplier: 1 },
  { code: 'box', name: 'Boxes', category: UOM_CATEGORIES.COUNT, baseMultiplier: 1 },
  { code: 'carton', name: 'Cartons', category: UOM_CATEGORIES.COUNT, baseMultiplier: 1 },
  { code: 'bag', name: 'Bags', category: UOM_CATEGORIES.COUNT, baseMultiplier: 1 },
  { code: 'sack', name: 'Sacks', category: UOM_CATEGORIES.COUNT, baseMultiplier: 1 },
  { code: 'tin', name: 'Tins', category: UOM_CATEGORIES.COUNT, baseMultiplier: 1 },
  { code: 'can', name: 'Cans', category: UOM_CATEGORIES.COUNT, baseMultiplier: 1 },
  { code: 'drum', name: 'Drums', category: UOM_CATEGORIES.COUNT, baseMultiplier: 1 },
  { code: 'barrel', name: 'Barrels', category: UOM_CATEGORIES.COUNT, baseMultiplier: 1 },
  { code: 'pallet', name: 'Pallets', category: UOM_CATEGORIES.COUNT, baseMultiplier: 1 },
  { code: 'case', name: 'Cases', category: UOM_CATEGORIES.COUNT, baseMultiplier: 1 },
  { code: 'bundle', name: 'Bundles', category: UOM_CATEGORIES.COUNT, baseMultiplier: 1 },
  { code: 'roll', name: 'Rolls', category: UOM_CATEGORIES.COUNT, baseMultiplier: 1 },
  { code: 'sheet', name: 'Sheets', category: UOM_CATEGORIES.COUNT, baseMultiplier: 1 },
  { code: 'pair', name: 'Pairs', category: UOM_CATEGORIES.COUNT, baseMultiplier: 2 },
  { code: 'set', name: 'Sets', category: UOM_CATEGORIES.COUNT, baseMultiplier: 1 },
  { code: 'dozen', name: 'Dozens', category: UOM_CATEGORIES.COUNT, baseMultiplier: 12 },

  // Mass (Base: Grams)
  { code: 'mg', name: 'Milligrams', category: UOM_CATEGORIES.MASS, baseMultiplier: 0.001 },
  { code: 'g', name: 'Grams', category: UOM_CATEGORIES.MASS, baseMultiplier: 1 },
  { code: 'kg', name: 'Kilograms', category: UOM_CATEGORIES.MASS, baseMultiplier: 1000 },
  { code: 'quintal', name: 'Quintals', category: UOM_CATEGORIES.MASS, baseMultiplier: 100000 },
  { code: 'tonne', name: 'Metric Tonnes', category: UOM_CATEGORIES.MASS, baseMultiplier: 1000000 },
  { code: 'ton', name: 'Metric Tonnes', category: UOM_CATEGORIES.MASS, baseMultiplier: 1000000 },
  { code: 'lb', name: 'Pounds', category: UOM_CATEGORIES.MASS, baseMultiplier: 453.59237 },

  // Volume (Base: Millilitres)
  { code: 'ml', name: 'Millilitres', category: UOM_CATEGORIES.VOLUME, baseMultiplier: 1 },
  { code: 'cl', name: 'Centilitres', category: UOM_CATEGORIES.VOLUME, baseMultiplier: 10 },
  { code: 'l', name: 'Litres', category: UOM_CATEGORIES.VOLUME, baseMultiplier: 1000 },
  { code: 'litre', name: 'Litres', category: UOM_CATEGORIES.VOLUME, baseMultiplier: 1000 },
  { code: 'liter', name: 'Litres', category: UOM_CATEGORIES.VOLUME, baseMultiplier: 1000 },
  { code: 'kl', name: 'Kilolitres', category: UOM_CATEGORIES.VOLUME, baseMultiplier: 1000000 },
  { code: 'm3', name: 'Cubic Metres', category: UOM_CATEGORIES.VOLUME, baseMultiplier: 1000000 },
  { code: 'cubic meter', name: 'Cubic Metres', category: UOM_CATEGORIES.VOLUME, baseMultiplier: 1000000 },
  { code: 'cubic metre', name: 'Cubic Metres', category: UOM_CATEGORIES.VOLUME, baseMultiplier: 1000000 },

  // Length (Base: Millimetres)
  { code: 'mm', name: 'Millimetres', category: UOM_CATEGORIES.LENGTH, baseMultiplier: 1 },
  { code: 'cm', name: 'Centimetres', category: UOM_CATEGORIES.LENGTH, baseMultiplier: 10 },
  { code: 'm', name: 'Metres', category: UOM_CATEGORIES.LENGTH, baseMultiplier: 1000 },
  { code: 'metre', name: 'Metres', category: UOM_CATEGORIES.LENGTH, baseMultiplier: 1000 },
  { code: 'meter', name: 'Metres', category: UOM_CATEGORIES.LENGTH, baseMultiplier: 1000 },
  { code: 'km', name: 'Kilometres', category: UOM_CATEGORIES.LENGTH, baseMultiplier: 1000000 },
  { code: 'inch', name: 'Inches', category: UOM_CATEGORIES.LENGTH, baseMultiplier: 25.4 },
  { code: 'ft', name: 'Feet', category: UOM_CATEGORIES.LENGTH, baseMultiplier: 304.8 },
  { code: 'yard', name: 'Yards', category: UOM_CATEGORIES.LENGTH, baseMultiplier: 914.4 },

  // Area (Base: Square Metres)
  { code: 'sq mm', name: 'Square Millimetres', category: UOM_CATEGORIES.AREA, baseMultiplier: 0.000001 },
  { code: 'sq cm', name: 'Square Centimetres', category: UOM_CATEGORIES.AREA, baseMultiplier: 0.0001 },
  { code: 'sq m', name: 'Square Metres', category: UOM_CATEGORIES.AREA, baseMultiplier: 1 },
  { code: 'sq ft', name: 'Square Feet', category: UOM_CATEGORIES.AREA, baseMultiplier: 0.092903 },
  { code: 'sq yd', name: 'Square Yards', category: UOM_CATEGORIES.AREA, baseMultiplier: 0.836127 }
];

const UOM_MAP = new Map();
STANDARD_UOMS.forEach((u) => {
  UOM_MAP.set(u.code.toLowerCase(), u);
  UOM_MAP.set(u.name.toLowerCase(), u);
});

/**
 * Get UOM metadata
 */
function getUomInfo(codeOrName) {
  if (!codeOrName || typeof codeOrName !== 'string') return null;
  const key = codeOrName.trim().toLowerCase();
  return UOM_MAP.get(key) || {
    code: codeOrName.trim(),
    name: codeOrName.trim(),
    category: UOM_CATEGORIES.CUSTOM,
    baseMultiplier: 1
  };
}

/**
 * Convert quantity between units within the same category.
 * Throws Error if cross-dimensional conversion is attempted without formula.
 */
function convertIntraCategory(quantity, fromUnit, toUnit) {
  const q = Number(quantity);
  if (!Number.isFinite(q)) throw new Error('Invalid quantity for UOM conversion');

  const fromInfo = getUomInfo(fromUnit);
  const toInfo = getUomInfo(toUnit);

  if (!fromInfo || !toInfo) {
    throw new Error(`Unknown units for conversion: "${fromUnit}" -> "${toUnit}"`);
  }

  // Same unit
  if (fromInfo.code.toLowerCase() === toInfo.code.toLowerCase()) {
    return q;
  }

  // Must belong to the same category for automatic conversion
  if (fromInfo.category !== toInfo.category || fromInfo.category === UOM_CATEGORIES.CUSTOM) {
    throw new Error(
      `Cannot automatically convert across categories: "${fromUnit}" (${fromInfo.category}) -> "${toUnit}" (${toInfo.category}). Manufacturing formula or packaging hierarchy is required.`
    );
  }

  // Direct conversion via base dimension multiplier
  const baseValue = q * fromInfo.baseMultiplier;
  const converted = baseValue / toInfo.baseMultiplier;
  return Math.round(converted * 10000) / 10000;
}

module.exports = {
  UOM_CATEGORIES,
  STANDARD_UOMS,
  getUomInfo,
  convertIntraCategory
};
