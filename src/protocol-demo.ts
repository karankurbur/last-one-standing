/**
 * Protocol demo — manually walk through the 402 Challenge/Credential/Receipt flow.
 * Shows what happens under the hood when mppx/client handles payments.
 */

const SERVER = process.env.SERVER_URL ?? "http://localhost:3000";

async function main() {
  console.log("=== MPP Protocol Flow Demo ===\n");
  console.log(`Target: ${SERVER}/api/joke\n`);

  // Step 1: Make a request without payment credentials
  console.log("Step 1: Request without payment →");
  const res = await fetch(`${SERVER}/api/joke`);
  console.log(`  Status: ${res.status} (${res.statusText})`);

  if (res.status === 402) {
    // Step 2: Inspect the 402 Challenge
    console.log("\nStep 2: Inspect 402 Challenge →");

    const wwwAuth = res.headers.get("www-authenticate");
    console.log(`  WWW-Authenticate: ${wwwAuth}`);

    // Parse the Payment challenge parameters
    if (wwwAuth) {
      const params: Record<string, string> = {};
      // Match key="value" pairs in the auth header
      const regex = /(\w+)="([^"]*?)"/g;
      let match;
      while ((match = regex.exec(wwwAuth)) !== null) {
        params[match[1]] = match[2];
      }
      console.log("\n  Parsed challenge:");
      console.log(`    scheme:  Payment`);
      console.log(`    id:      ${params.id ?? "N/A"}`);
      console.log(`    method:  ${params.method ?? "N/A"}`);
      console.log(`    intent:  ${params.intent ?? "N/A"}`);
      console.log(`    realm:   ${params.realm ?? "N/A"}`);

      // Decode the base64url request parameter
      if (params.request) {
        try {
          const decoded = JSON.parse(
            Buffer.from(params.request, "base64url").toString()
          );
          console.log(`    request (decoded):`);
          console.log(`      amount:    ${decoded.amount}`);
          console.log(`      currency:  ${decoded.currency}`);
          console.log(`      recipient: ${decoded.recipient}`);
          if (decoded.description)
            console.log(`      description: ${decoded.description}`);
        } catch {
          console.log(`    request (raw): ${params.request}`);
        }
      }
    }

    // Check for Problem Details body
    const contentType = res.headers.get("content-type");
    if (contentType?.includes("json")) {
      const body = await res.json();
      console.log("\n  Problem Details body:", JSON.stringify(body, null, 4));
    }

    console.log("\nStep 3: To complete the flow →");
    console.log("  The client would:");
    console.log("  a) Parse the challenge");
    console.log("  b) Sign a TIP-20 transfer for the requested amount");
    console.log("  c) Retry with Authorization: Payment <credential>");
    console.log("  d) Server verifies, broadcasts tx, returns 200 + Receipt");
    console.log("\n  (Run the client script to see this happen automatically)");
  } else {
    console.log("  Unexpected — expected 402. Got:", await res.text());
  }
}

main().catch(console.error);
