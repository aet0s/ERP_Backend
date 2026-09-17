'use strict';

/**
 * manufacturingEngine.js
 * Manufacturing Formula, Scaling, Yield, and Multi-Output Cost Allocation Engine.
 */

/**
 * Validates a manufacturing formula structure.
 */
function validateFormula({ name, inputs, outputs, cost_allocation_method = 'manual_percentage' }) {
  if (!name || !name.trim()) {
    throw new Error('Formula name is required');
  }

  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new Error('Manufacturing formula must have at least one input material/component');
  }

  if (!Array.isArray(outputs) || outputs.length === 0) {
    throw new Error('Manufacturing formula must have at least one output product');
  }

  for (let i = 0; i < inputs.length; i++) {
    const inp = inputs[i];
    const inpId = inp.item_id || inp.product_id || inp.raw_material_id;
    if (!inpId) throw new Error(`Input #${i + 1}: item_id is required`);
    inp.item_id = inpId;
    const q = Number(inp.quantity);
    if (!Number.isFinite(q) || q <= 0) throw new Error(`Input #${i + 1}: quantity must be > 0`);
    if (!inp.uom || !inp.uom.trim()) throw new Error(`Input #${i + 1}: uom is required`);
  }

  for (let i = 0; i < outputs.length; i++) {
    const out = outputs[i];
    const outId = out.item_id || out.product_id;
    if (!outId) throw new Error(`Output #${i + 1}: item_id is required`);
    out.item_id = outId;
    const q = Number(out.quantity);
    if (!Number.isFinite(q) || q <= 0) throw new Error(`Output #${i + 1}: quantity must be > 0`);
    if (!out.uom || !out.uom.trim()) throw new Error(`Output #${i + 1}: uom is required`);
  }

  // Cost allocation is proportional to produced output quantities - no manual 100% enforcement needed
}

/**
 * Scales a formula's inputs and outputs given a target scale or target output quantity.
 *
 * @param {Object} formula - Formula with inputs: [], outputs: []
 * @param {Number} targetScaleOrOutputQty - Scale multiplier (e.g. 2.5) or absolute quantity of primary output
 * @param {Boolean} isScaleMultiplier - If true, target is multiplier; if false, target is desired primary output qty
 */
function scaleFormula(formula, targetScaleOrOutputQty, isScaleMultiplier = false) {
  if (!formula || !Array.isArray(formula.inputs) || !Array.isArray(formula.outputs) || formula.outputs.length === 0) {
    throw new Error('Invalid formula structure for scaling');
  }

  let scaleMultiplier = 1;
  const primaryOutput = formula.outputs[0];
  const basePrimaryQty = Number(primaryOutput.quantity) || 1;

  if (isScaleMultiplier) {
    scaleMultiplier = Number(targetScaleOrOutputQty) || 1;
  } else {
    const desiredQty = Number(targetScaleOrOutputQty) || basePrimaryQty;
    scaleMultiplier = desiredQty / basePrimaryQty;
  }

  if (scaleMultiplier <= 0) {
    scaleMultiplier = 1;
  }

  // Scale inputs considering expected loss / wastage percentage
  const scaledInputs = formula.inputs.map((inp, idx) => {
    const baseQty = Number(inp.quantity) || 0;
    const lossPct = Number(inp.expected_loss_percent != null ? inp.expected_loss_percent : inp.scrap_percentage) || 0;
    // Theoretical raw requirement without loss
    const rawRequired = Math.round((baseQty * scaleMultiplier) * 10000) / 10000;
    // Expected requirement taking loss into account: rawRequired * (1 + loss/100)
    const expectedQtyWithLoss = Math.round((rawRequired * (1 + (lossPct / 100))) * 10000) / 10000;

    const unitCost = Math.max(0, Number(inp.unit_cost ?? inp.effective_purchase_price ?? inp.last_purchase_price ?? inp.purchase_price ?? inp.cost ?? 0));
    const lineCost = Math.round((expectedQtyWithLoss * unitCost) * 100) / 100;

    return {
      ...inp,
      item_id: inp.item_id || inp.product_id || inp.raw_material_id,
      product_id: inp.item_id || inp.product_id || inp.raw_material_id,
      raw_material_id: inp.item_id || inp.product_id || inp.raw_material_id,
      sequence: inp.sequence || idx + 1,
      scaled_quantity: rawRequired,
      raw_required_quantity: rawRequired,
      expected_quantity: expectedQtyWithLoss,
      required_with_scrap: expectedQtyWithLoss,
      required_quantity_with_scrap: expectedQtyWithLoss,
      base_formula_quantity: baseQty,
      scale_factor: scaleMultiplier,
      unit_cost: unitCost,
      line_cost: lineCost
    };
  });

  const totalEstimatedInputCost = Math.round(scaledInputs.reduce((sum, i) => sum + Number(i.line_cost || 0), 0) * 100) / 100;

  // Scale outputs and allocate estimated cost
  const rawScaledOutputs = formula.outputs.map((out, idx) => {
    const baseQty = Number(out.quantity) || 0;
    const expectedQty = Math.round((baseQty * scaleMultiplier) * 10000) / 10000;

    return {
      ...out,
      item_id: out.item_id || out.product_id,
      product_id: out.product_id || out.item_id,
      scaled_quantity: expectedQty,
      expected_quantity: expectedQty,
      quantity_produced: expectedQty,
      base_formula_quantity: baseQty,
      scale_factor: scaleMultiplier
    };
  });

  const allocatedOutputs = allocateProductionCosts(
    rawScaledOutputs,
    totalEstimatedInputCost,
    formula.cost_allocation_method || 'equal_split'
  );

  const finalOutputs = allocatedOutputs.map(o => ({
    ...o,
    estimated_unit_cost: o.unit_cost,
    allocated_cost: o.allocated_cost
  }));

  return {
    scale_factor: scaleMultiplier,
    total_estimated_input_cost: totalEstimatedInputCost,
    total_input_cost: totalEstimatedInputCost,
    inputs: scaledInputs,
    outputs: finalOutputs
  };
}

/**
 * Allocates total production cost across multiple outputs with exact rounding tie-out.
 *
 * @param {Array} outputs - [{ item_id, quantity_produced, cost_allocation_percent, default_selling_price }]
 * @param {Number} totalCost - Grand total of input material costs + labor + other
 * @param {String} method - 'manual_percentage' | 'value_based' | 'equal_split'
 */
function allocateProductionCosts(outputs, totalCost, method = 'manual_percentage') {
  if (!Array.isArray(outputs) || outputs.length === 0) return [];
  const grandCost = Math.max(0, Number(totalCost) || 0);

  if (outputs.length === 1) {
    const qty = Math.max(0.0001, Number(outputs[0].quantity_produced) || 1);
    return [{
      ...outputs[0],
      cost_allocation_percent: 100,
      allocated_cost: grandCost,
      unit_cost: Math.round((grandCost / qty) * 10000) / 10000
    }];
  }

  let weights = [];

  if (method === 'value_based') {
    // Weight = quantity_produced * default_selling_price
    weights = outputs.map((o) => {
      const q = Math.max(0, Number(o.quantity_produced) || 0);
      const price = Math.max(0, Number(o.default_selling_price || o.package_selling_price || 0));
      return q * price;
    });
  } else if (method === 'equal_split') {
    weights = outputs.map(() => 1);
  } else if (method === 'manual_percentage' && outputs.some(o => Number(o.cost_allocation_percent) > 0)) {
    weights = outputs.map((o) => Math.max(0, Number(o.cost_allocation_percent) || 0));
  } else {
    // Quantity-based: how much money is gone into raw materials and how much final products are produced
    weights = outputs.map((o) => Math.max(0, Number(o.quantity_produced ?? o.quantity ?? 0)));
  }

  let totalWeight = weights.reduce((s, w) => s + w, 0);
  if (totalWeight <= 0) {
    weights = outputs.map(() => 1);
    totalWeight = weights.reduce((s, w) => s + w, 0);
  }
  const allocatedOutputs = [];
  let sumAllocated = 0;

  for (let i = 0; i < outputs.length; i++) {
    const out = outputs[i];
    const qty = Math.max(0.0001, Number(out.quantity_produced) || 1);
    const w = weights[i];
    const pct = totalWeight > 0 ? (w / totalWeight) * 100 : (100 / outputs.length);

    let allocated = 0;
    if (i === outputs.length - 1) {
      // Last item gets exact remainder so sum matches grandCost down to the cent
      allocated = Math.round((grandCost - sumAllocated) * 100) / 100;
    } else {
      allocated = Math.round(((grandCost * pct) / 100) * 100) / 100;
      sumAllocated += allocated;
    }

    const unitCost = Math.round((allocated / qty) * 10000) / 10000;

    allocatedOutputs.push({
      ...out,
      cost_allocation_percent: Math.round(pct * 100) / 100,
      allocated_cost: allocated,
      unit_cost: unitCost
    });
  }

  return allocatedOutputs;
}

/**
 * Calculates operational yield and variances between expected and actual production.
 */
function calculateYieldAndVariances(inputs = [], outputs = []) {
  const inputVariances = inputs.map((inp) => {
    const exp = Number(inp.expected_quantity);
    const act = Number(inp.quantity || inp.actual_quantity || 0);
    const hasExp = Number.isFinite(exp) && exp > 0;
    const variance = hasExp ? act - exp : 0;
    const variancePct = hasExp ? (variance / exp) * 100 : 0;

    return {
      item_id: inp.item_id,
      expected: hasExp ? exp : null,
      actual: act,
      variance,
      variance_percent: Math.round(variancePct * 100) / 100
    };
  });

  const outputVariances = outputs.map((out) => {
    const exp = Number(out.expected_quantity);
    const act = Number(out.quantity_produced || 0);
    const hasExp = Number.isFinite(exp) && exp > 0;
    const variance = hasExp ? act - exp : 0;
    const yieldPct = hasExp ? (act / exp) * 100 : 100;

    return {
      item_id: out.item_id,
      expected: hasExp ? exp : null,
      actual: act,
      variance,
      yield_percent: Math.round(yieldPct * 100) / 100
    };
  });

  // Overall yield across outputs where expected was defined
  const totalExp = outputVariances.filter((o) => o.expected !== null).reduce((s, o) => s + (o.expected || 0), 0);
  const totalAct = outputVariances.filter((o) => o.expected !== null).reduce((s, o) => s + o.actual, 0);
  const overallYield = totalExp > 0 ? (totalAct / totalExp) * 100 : 100;

  return {
    overall_yield_percent: Math.round(overallYield * 100) / 100,
    inputs: inputVariances,
    outputs: outputVariances
  };
}

module.exports = {
  validateFormula,
  scaleFormula,
  allocateProductionCosts,
  calculateYieldAndVariances
};
