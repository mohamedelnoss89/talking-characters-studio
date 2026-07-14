import ZAI from 'z-ai-web-dev-sdk';

async function test() {
  console.log("Creating ZAI instance...");
  const zai = await ZAI.create();
  console.log("Calling images.generations.create...");
  const start = Date.now();
  const response = await zai.images.generations.create({
    prompt: "a businessman in a suit, photorealistic portrait",
    size: "1024x1024",
  });
  console.log(`Done in ${Date.now() - start}ms`);
  const b64 = response?.data?.[0]?.base64;
  console.log("Base64 length:", b64 ? b64.length : 0);
  if (b64 && b64.length > 1000) {
    console.log("✓ Image generation works!");
  } else {
    console.log("✗ No image data");
    console.log("Full response:", JSON.stringify(response).slice(0, 500));
  }
}

test().catch(e => { console.error("FAILED:", e.message); process.exit(1); });
