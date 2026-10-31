// ============================================================================
// FILE: src/backend/validators/requestValidator.js
// PURPOSE: Input Validation Rules for Products, Customers, POS Sales & Finance
// ============================================================================

export function validateActionPayload(action, payload = {}) {
  if (action === 'ADD_PRODUCT' || action === 'UPDATE_PRODUCT') {
    if (!payload.name || String(payload.name).trim().length === 0) {
      return { valid: false, error: 'Product name is required.' };
    }
    if (Number(payload.retailPrice) < 0 || Number(payload.purchasePrice) < 0) {
      return { valid: false, error: 'Product price cannot be negative.' };
    }
  }

  if (action === 'ADD_CUSTOMER' || action === 'UPDATE_CUSTOMER') {
    if (!payload.name || !payload.phone) {
      return { valid: false, error: 'Customer name and phone number are required.' };
    }
  }

  if (action === 'CREATE_SALE') {
    if (!Array.isArray(payload.items) || payload.items.length === 0) {
      return { valid: false, error: 'POS Sale must contain at least one item.' };
    }
  }

  if (action === 'COLLECT_DUE') {
    if (!payload.customerId || Number(payload.amount) <= 0) {
      return { valid: false, error: 'Valid customer and positive collection amount are required.' };
    }
  }

  if (action === 'ADD_FINANCE_TRX') {
    if (Number(payload.amount) <= 0) {
      return { valid: false, error: 'Transaction amount must be greater than zero.' };
    }
  }

  if (action === 'ADD_EMPLOYEE' || action === 'UPDATE_EMPLOYEE') {
    if (!payload.name || String(payload.name).trim().length === 0) {
      return { valid: false, error: 'Employee name is required.' };
    }
  }

  return { valid: true };
}

