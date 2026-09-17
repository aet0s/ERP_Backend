'use strict';

/**
 * packagingEngine.js
 * Multi-Level Packaging Hierarchy, Cycle Detection, Base Inventory Conversion,
 * Capacity Calculation, and Packaging BOM Costing.
 */

/**
 * Detects circular references in a packaging hierarchy.
 *
 * @param {String|null} parentLevelId - The parent level being set
 * @param {String} currentLevelId - The ID of the level being created or updated
 * @param {Map|Object} levelsById - Map or object containing existing levels keyed by id
 */
function detectCycle(parentLevelId, currentLevelId, levelsById) {
  if (!parentLevelId) return false;
  if (parentLevelId === currentLevelId) return true;

  const visited = new Set([currentLevelId]);
  let currentParentId = parentLevelId;

  while (currentParentId) {
    if (visited.has(currentParentId)) {
      return true; // Cycle detected!
    }
    visited.add(currentParentId);
    const parentLevel = levelsById instanceof Map ? levelsById.get(currentParentId) : levelsById[currentParentId];
    currentParentId = parentLevel ? parentLevel.parent_level_id : null;
  }

  return false;
}

/**
 * Calculates the total base quantity equivalent for a packaging level by traversing parents.
 *
 * @param {Object} level - The level being evaluated: { contains_quantity, parent_level_id }
 * @param {Map|Object} levelsById - Existing levels map
 * @returns {Number} Total equivalent in atomic base units
 */
function computeBaseQuantityEquivalent(level, levelsById) {
  const containsQty = Number(level.contains_quantity);
  if (!Number.isFinite(containsQty) || containsQty <= 0) {
    throw new Error('Packaging contains_quantity must be a positive number');
  }

  if (!level.parent_level_id) {
    // Root packaging level: directly wraps the base product
    return containsQty;
  }

  const parent = levelsById instanceof Map ? levelsById.get(level.parent_level_id) : levelsById[level.parent_level_id];
  if (!parent) {
    throw new Error(`Parent packaging level "${level.parent_level_id}" not found`);
  }

  // Parent's base equivalent * this level's contains_quantity
  const parentBaseEquivalent = Number(parent.base_quantity_equivalent) || computeBaseQuantityEquivalent(parent, levelsById);
  const totalBaseEquivalent = Math.round((containsQty * parentBaseEquivalent) * 10000) / 10000;
  return totalBaseEquivalent;
}

/**
 * Validates packaging level creation or modification.
 */
function validatePackagingLevel(levelData, existingLevels = []) {
  const { name, package_unit, contains_quantity, product_id, parent_level_id, id } = levelData;

  if (!product_id) throw new Error('Product ID is required for packaging configuration');
  if (!name || !name.trim()) throw new Error('Package name is required (e.g. "Box of 20", "Carton of 50")');
  if (!package_unit || !package_unit.trim()) throw new Error('Package unit is required (e.g. "Box", "Carton", "Tin")');

  const containsQty = Number(contains_quantity);
  if (!Number.isFinite(containsQty) || containsQty <= 0) {
    throw new Error('Contains quantity must be a positive number greater than 0');
  }

  const levelsMap = new Map();
  for (const l of existingLevels) {
    levelsMap.set(l.id, l);
  }

  if (parent_level_id) {
    const parent = levelsMap.get(parent_level_id);
    if (!parent) {
      throw new Error('Selected parent packaging level does not exist');
    }
    if (parent.product_id !== product_id) {
      throw new Error('Parent packaging level must belong to the exact same product');
    }
    if (id && detectCycle(parent_level_id, id, levelsMap)) {
      throw new Error('Circular packaging hierarchy detected! A package cannot directly or indirectly enclose itself.');
    }
  }
}

/**
 * Calculates packaging capacity given an available quantity of base stock.
 *
 * @param {Number} availableBaseQty - Available inventory in base units
 * @param {Number} packageBaseEquivalent - Total base units contained in one package
 * @returns {Object} { complete_packages, remainder_base_quantity, package_base_equivalent }
 */
function calculatePackagingCapacity(availableBaseQty, packageBaseEquivalent) {
  const avail = Math.max(0, Number(availableBaseQty) || 0);
  const pkgBase = Number(packageBaseEquivalent);

  if (!Number.isFinite(pkgBase) || pkgBase <= 0) {
    return {
      available_base_quantity: avail,
      package_base_equivalent: 0,
      complete_packages: 0,
      remainder_base_quantity: avail
    };
  }

  const completePackages = Math.floor(avail / pkgBase);
  const remainder = Math.round((avail - (completePackages * pkgBase)) * 10000) / 10000;

  return {
    available_base_quantity: avail,
    package_base_equivalent: pkgBase,
    complete_packages: completePackages,
    remainder_base_quantity: remainder
  };
}

/**
 * Calculates total packaged product cost incorporating:
 * - Base product manufacturing cost
 * - Packaging materials BOM cost (box, bottle, cap, label, seal)
 *
 * @param {Number} baseProductCost - Cost per atomic base unit of product
 * @param {Number} baseEquivalent - Total base units in package
 * @param {Array} materials - Attached packaging materials [{ quantity, cost_per_unit }]
 */
function calculateTotalPackagedCost(baseProductCost, baseEquivalent, materials = []) {
  const baseCost = Math.max(0, Number(baseProductCost) || 0);
  const baseEquiv = Math.max(1, Number(baseEquivalent) || 1);

  const baseProductCostComponent = Math.round((baseCost * baseEquiv) * 100) / 100;

  const packagingMaterialCost = (materials || []).reduce((sum, m) => {
    const q = Math.max(0, Number(m.quantity) || 0);
    const c = Math.max(0, Number(m.cost_per_unit) || 0);
    return sum + (q * c);
  }, 0);

  const totalPackageCost = Math.round((baseProductCostComponent + packagingMaterialCost) * 100) / 100;
  const effectiveCostPerBaseUnit = baseEquiv > 0 ? Math.round((totalPackageCost / baseEquiv) * 10000) / 10000 : 0;

  return {
    base_product_cost_component: baseProductCostComponent,
    packaging_material_cost: Math.round(packagingMaterialCost * 100) / 100,
    total_package_cost: totalPackageCost,
    effective_cost_per_base_unit: effectiveCostPerBaseUnit
  };
}

/**
 * Computes the derived selling price for a packaging level given the base selling price
 * and the cumulative base quantity equivalent.
 *
 * @param {Number} baseSellingPrice - Price of one atomic base unit
 * @param {Number} baseQuantityEquivalent - Number of base units in package
 * @returns {Number} Rounded selling price for the package
 */
function computePackagingSellingPrice(baseSellingPrice, baseQuantityEquivalent) {
  const basePrice = Math.max(0, Number(baseSellingPrice) || 0);
  const baseEquiv = Math.max(1, Number(baseQuantityEquivalent) || 1);
  return Math.round((basePrice * baseEquiv) * 100) / 100;
}

/**
 * Validates and calculates production run output allocations across packaging levels and loose units.
 * Ensures that total consumed base units do not exceed produced quantity and returns exact remaining loose units.
 *
 * @param {Number} producedQty - Total base units produced in this output line
 * @param {Array} allocations - [{ packaging_level_id, package_count }]
 * @param {Map|Object|Array} levelsById - Available packaging levels for this product
 * @returns {Object} { producible_quantity, total_base_consumed, loose_remaining, allocations }
 */
function allocateProducedQuantity(producedQty, allocations = [], levelsById = {}) {
  const totalProduced = Math.max(0, Number(producedQty) || 0);

  const levelsMap = new Map();
  if (levelsById instanceof Map) {
    for (const [k, v] of levelsById.entries()) levelsMap.set(k, v);
  } else if (Array.isArray(levelsById)) {
    for (const l of levelsById) if (l && l.id) levelsMap.set(l.id, l);
  } else if (typeof levelsById === 'object' && levelsById !== null) {
    for (const [k, v] of Object.entries(levelsById)) levelsMap.set(k, v);
  }

  const normalizedAllocations = [];
  let totalBaseConsumed = 0;

  for (let i = 0; i < (allocations || []).length; i++) {
    const alloc = allocations[i];
    const pkgCount = Math.max(0, Number(alloc.package_count) || 0);
    if (pkgCount <= 0) continue;

    if (alloc.packaging_level_id) {
      const level = levelsMap.get(alloc.packaging_level_id);
      if (!level) {
        throw new Error(`Allocation #${i + 1}: Packaging level "${alloc.packaging_level_id}" not found`);
      }
      const baseEquiv = Number(level.base_quantity_equivalent) || 1;
      const baseConsumed = Math.round((pkgCount * baseEquiv) * 10000) / 10000;

      totalBaseConsumed += baseConsumed;
      normalizedAllocations.push({
        packaging_level_id: alloc.packaging_level_id,
        level_name: level.name,
        package_unit: level.package_unit,
        base_quantity_equivalent: baseEquiv,
        package_count: pkgCount,
        base_units_consumed: baseConsumed
      });
    } else {
      // Loose / unpackaged allocation
      const baseConsumed = Math.round(pkgCount * 10000) / 10000;
      totalBaseConsumed += baseConsumed;
      normalizedAllocations.push({
        packaging_level_id: null,
        level_name: 'Loose / Unpackaged',
        package_unit: alloc.unit || 'unit',
        base_quantity_equivalent: 1,
        package_count: pkgCount,
        base_units_consumed: baseConsumed
      });
    }
  }

  totalBaseConsumed = Math.round(totalBaseConsumed * 10000) / 10000;

  if (totalBaseConsumed > (totalProduced + 0.0001)) {
    const diff = Math.round((totalBaseConsumed - totalProduced) * 100) / 100;
    throw new Error(`Total allocated units (${totalBaseConsumed}) exceeds produced quantity (${totalProduced}) by ${diff}`);
  }

  const looseRemaining = Math.max(0, Math.round((totalProduced - totalBaseConsumed) * 10000) / 10000);

  return {
    producible_quantity: totalProduced,
    total_base_consumed: totalBaseConsumed,
    loose_remaining: looseRemaining,
    allocations: normalizedAllocations
  };
}

module.exports = {
  detectCycle,
  computeBaseQuantityEquivalent,
  validatePackagingLevel,
  calculatePackagingCapacity,
  calculateTotalPackagedCost,
  computePackagingSellingPrice,
  allocateProducedQuantity
};
