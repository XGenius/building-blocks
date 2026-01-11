/**
 * Authentication Middleware
 *
 * Verifies Supabase JWT tokens and attaches user to request.
 * Use isAuthenticated for protected routes.
 */

import { Request, Response, NextFunction } from "express";
import { createClient } from "@supabase/supabase-js";

// Extend Express Request type to include user
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email?: string;
        role?: string;
      };
    }
  }
}

// Initialize Supabase admin client for token verification
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.warn(
    "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Auth middleware disabled."
  );
}

const supabaseAdmin =
  supabaseUrl && supabaseServiceKey
    ? createClient(supabaseUrl, supabaseServiceKey, {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      })
    : null;

/**
 * Extract Bearer token from Authorization header
 */
function extractToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  if (!authHeader.startsWith("Bearer ")) return null;
  return authHeader.slice(7);
}

/**
 * Middleware to verify JWT and attach user to request
 *
 * Usage:
 *   app.get('/api/protected', isAuthenticated, (req, res) => {
 *     console.log(req.user.id);
 *   });
 */
export async function isAuthenticated(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!supabaseAdmin) {
    res.status(500).json({ error: "Auth not configured" });
    return;
  }

  const token = extractToken(req.headers.authorization);

  if (!token) {
    res.status(401).json({ error: "Missing authorization token" });
    return;
  }

  try {
    // Verify the JWT with Supabase
    const {
      data: { user },
      error,
    } = await supabaseAdmin.auth.getUser(token);

    if (error || !user) {
      res.status(401).json({ error: "Invalid or expired token" });
      return;
    }

    // Attach user to request
    req.user = {
      id: user.id,
      email: user.email,
      role: user.role,
    };

    next();
  } catch (error) {
    console.error("[Auth] Error verifying token:", error);
    res.status(401).json({ error: "Token verification failed" });
  }
}

/**
 * Optional authentication middleware
 * Attaches user if valid token present, but doesn't require it
 *
 * Usage:
 *   app.get('/api/public', optionalAuth, (req, res) => {
 *     if (req.user) {
 *       // Authenticated user
 *     } else {
 *       // Anonymous user
 *     }
 *   });
 */
export async function optionalAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!supabaseAdmin) {
    next();
    return;
  }

  const token = extractToken(req.headers.authorization);

  if (!token) {
    next();
    return;
  }

  try {
    const {
      data: { user },
    } = await supabaseAdmin.auth.getUser(token);

    if (user) {
      req.user = {
        id: user.id,
        email: user.email,
        role: user.role,
      };
    }
  } catch {
    // Ignore errors for optional auth
  }

  next();
}

export default isAuthenticated;
