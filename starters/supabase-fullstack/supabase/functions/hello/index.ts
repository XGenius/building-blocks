/**
 * Example Supabase Edge Function
 *
 * Deploy with: supabase functions deploy hello
 * Invoke with: supabase functions invoke hello --body '{"name":"World"}'
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

interface RequestBody {
  name?: string;
}

Deno.serve(async (req: Request) => {
  try {
    // Parse request body
    const body: RequestBody = await req.json();
    const name = body.name || "Anonymous";

    // Return response
    const data = {
      message: `Hello ${name}!`,
      timestamp: new Date().toISOString(),
    };

    return new Response(JSON.stringify(data), {
      headers: {
        "Content-Type": "application/json",
        // CORS headers if needed
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
});
