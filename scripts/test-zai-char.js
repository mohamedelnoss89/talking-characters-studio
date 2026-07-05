// Quick test of the z-ai-web-dev-sdk image generation flow
const ZAI = require('z-ai-web-dev-sdk').default;
const fs = require('fs');

(async () => {
  console.log('[1] Creating ZAI instance...');
  const zai = await ZAI.create();
  console.log('[1] OK');

  console.log('[2] Calling chat completion to expand concept...');
  const t0 = Date.now();
  const completion = await zai.chat.completions.create({
    messages: [
      { role: 'assistant', content: 'You output ONLY JSON. Fields: visual_prompt (English string), description_ar (Arabic string), description_en (English string).' },
      { role: 'user', content: 'Concept: "شاب عربي مهندس كمبيوتر بنظارة". Style: realistic. Gender: male. Return JSON now.' }
    ],
    thinking: { type: 'disabled' },
  });
  console.log('[2] OK in', Date.now() - t0, 'ms');
  console.log('[2] Raw:', completion.choices?.[0]?.message?.content?.slice(0, 400));

  console.log('[3] Generating image...');
  const t1 = Date.now();
  const response = await zai.images.generations.create({
    prompt: 'front-facing portrait photo of a young Arab male computer engineer with glasses and a friendly smile, looking directly at camera, head and shoulders centered, plain solid background, even soft studio lighting, sharp focus, photorealistic professional portrait, studio lighting, 85mm lens',
    size: '1024x1024',
  });
  console.log('[3] OK in', Date.now() - t1, 'ms');
  const b64 = response.data?.[0]?.base64;
  if (!b64) {
    console.log('[3] FAIL: no base64');
    return;
  }
  console.log('[3] base64 length:', b64.length);
  fs.writeFileSync('/tmp/test-char.png', Buffer.from(b64, 'base64'));
  console.log('[3] Saved to /tmp/test-char.png');
})().catch(e => { console.error('ERR:', e); process.exit(1); });
