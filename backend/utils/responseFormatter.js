// ============================================================================
// FILE: src/backend/utils/responseFormatter.js
// PURPOSE: Standardized HTTP Response & Error Formatting Utilities
// ============================================================================

import { NextResponse } from 'next/server';

export const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
  Pragma: 'no-cache',
  Expires: '0'
};

export function sendSuccess(data = {}, status = 200) {
  return NextResponse.json(
    {
      ok: true,
      timestamp: new Date().toISOString(),
      ...data
    },
    { status, headers: NO_CACHE_HEADERS }
  );
}

export function sendError(errorMessage = 'Operation failed', status = 400, details = null) {
  return NextResponse.json(
    {
      ok: false,
      error: errorMessage,
      details,
      timestamp: new Date().toISOString()
    },
    { status, headers: NO_CACHE_HEADERS }
  );
}

