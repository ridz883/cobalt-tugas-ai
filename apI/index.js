import * as cheerio from 'cheerio';

const DEFAULT_API_KEY = process.env.XKIRO_API_KEY || 'sk-xt-f8c8a9432ddccf472ad7210961813d6d62f1a28e98f4440b';
const DEFAULT_MODEL = process.env.AI_MODEL || 'mistralai/mistral-large-4-0';
const XKIRO_ENDPOINT = 'https://api.xkiro.com/v1/chat/completions';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

/**
 * Helper: Ekstrak array JSON FB_PUBLIC_LOAD_DATA_ dengan penghitung kurung siku
 * Aman untuk semua versi Google Form & shortlink forms.gle
 */
function extractFbPublicLoadData(html) {
  const marker = 'FB_PUBLIC_LOAD_DATA_';
  const markerIdx = html.indexOf(marker);
  if (markerIdx === -1) return null;

  const startBracket = html.indexOf('[', markerIdx);
  if (startBracket === -1) return null;

  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = startBracket; i < html.length; i++) {
    const ch = html[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escapeNext = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (ch === '[') depth++;
      else if (ch === ']') {
        depth--;
        if (depth === 0) {
          const jsonStr = html.slice(startBracket, i + 1);
          return JSON.parse(jsonStr);
        }
      }
    }
  }
  return null;
}

/**
 * Helper: Deteksi apakah pertanyaan adalah kolom identitas (Nama, Kelas, Absen, NISN, Email, Token)
 */
function classifyIdentityKey(title = '', options = []) {
  const t = title.toLowerCase().trim();
  if (/\b(nama\s*lengkap|nama\s*siswa|nama\s*peserta|nama\s*anda|^nama$|full\s*name)\b/.test(t) && options.length === 0) {
    return 'nama';
  }
  if (/\b(kelas|rombel|jurusan|tingkat|program\s*keahlian|kompetensi\s*keahlian)\b/.test(t)) {
    return 'kelas';
  }
  if (/\b(no\.?\s*absen|nomor\s*absen|absensi|urut|^absen$)\b/.test(t)) {
    return 'absen';
  }
  if (/\b(nisn|nis|nomor\s*induk|npm|nim)\b/.test(t)) {
    return 'nisn';
  }
  if (/\b(email|surel|alamat\s*email)\b/.test(t) && options.length === 0) {
    return 'email';
  }
  if (/\b(token|password\s*ujian|kode\s*soal)\b/.test(t) && options.length === 0) {
    return 'token';
  }
  return null;
}

/**
 * Helper: Parse Google Form HTML (FB_PUBLIC_LOAD_DATA_)
 */
function parseGoogleFormHtml(html, finalUrl) {
  const rawData = extractFbPublicLoadData(html);

  if (!rawData) {
    const isLoginRedirect =
      html.includes('accounts.google.com/ServiceLogin') ||
      html.includes('accounts.google.com/v3/signin') ||
      finalUrl.includes('accounts.google.com');

    if (isLoginRedirect) {
      throw new Error('PRIVATE_FORM: Form ini dikunci (Wajib Login Akun Google). Masukkan Cookie Google di menu [Cookie & HTML] atau tempel kode HTML (view-source) form tersebut.');
    }
    throw new Error('Data soal Google Form tidak ditemukan. Pastikan link mengarah ke Google Form yang aktif.');
  }

  const formTitle = rawData[1]?.[8] || rawData[3] || 'Google Form Tugas';
  const formDesc = rawData[1]?.[0] || '';
  const rawItems = rawData[1]?.[1] || [];

  const fbzxMatch = html.match(/name="fbzx"\s+value="([^"]+)"/);
  const fbzx = fbzxMatch ? fbzxMatch[1] : '';

  const cleanBaseUrl = finalUrl.split('?')[0];
  const viewUrl = cleanBaseUrl.replace(/\/(formResponse|viewform).*$/, '/viewform');
  const submitUrl = cleanBaseUrl.replace(/\/(formResponse|viewform).*$/, '/formResponse');

  const identityFields = [];
  const quizQuestions = [];
  let pageCount = 1;

  for (const item of rawItems) {
    if (!Array.isArray(item)) continue;
    const itemId = item[0];
    const title = (item[1] || '').trim();
    const description = (item[2] || '').trim();
    const type = item[3];

    // Tipe 8 = Section Break (Pindah Halaman)
    if (type === 8) {
      pageCount++;
      continue;
    }

    // Lewati item non-pertanyaan
    if (!item[4] || !Array.isArray(item[4]) || !item[4][0]) continue;

    const inputMeta = item[4][0];
    const entryId = `entry.${inputMeta[0]}`;
    const rawOptions = inputMeta[1] || [];
    const options = rawOptions
      .map(opt => opt[0])
      .filter(v => v !== null && v !== undefined && String(v).trim() !== '');
    const isRequired = Boolean(inputMeta[2]);

    // Cek lampiran gambar pada soal
    let imageUrl = null;
    if (item[6] && Array.isArray(item[6]) && item[6][0]) {
      imageUrl = `https://drive.google.com/thumbnail?id=${item[6][0]}&sz=w1000`;
    }

    const identityKey = classifyIdentityKey(title, options);

    if (identityKey) {
      identityFields.push({
        entryId,
        key: identityKey,
        title,
        description,
        type,
        options,
        isRequired
      });
    } else {
      quizQuestions.push({
        id: String(itemId),
        entryId,
        question: title || 'Pertanyaan Tanpa Judul',
        description,
        type,
        options,
        imageUrl,
        isRequired
      });
    }
  }

  return {
    platform: 'google_form',
    formTitle,
    formDesc,
    viewUrl,
    submitUrl,
    fbzx,
    pageCount,
    identityFields,
    quizQuestions
  };
}

/**
 * Helper: Universal HTML Form Parser (Untuk Web Form Non-Google Form)
 */
function parseUniversalFormHtml(html, finalUrl) {
  const $ = cheerio.load(html);
  const formTitle = $('title').first().text().trim() || $('h1, h2').first().text().trim() || 'Web Tugas Online';
  const formEl = $('form').first();
  const rawAction = formEl.attr('action') || finalUrl;
  const submitUrl = new URL(rawAction, finalUrl).href;
  const method = (formEl.attr('method') || 'POST').toUpperCase();

  const identityFields = [];
  const quizQuestions = [];
  const processedNames = new Set();

  const root = formEl.length ? formEl : $('body');

  root.find('input, select, textarea').each((idx, el) => {
    const tag = el.tagName.toLowerCase();
    const typeAttr = ($(el).attr('type') || 'text').toLowerCase();
    const name = $(el).attr('name');

    if (!name || ['hidden', 'submit', 'button', 'reset', 'file'].includes(typeAttr)) return;
    if (processedNames.has(name)) return;
    processedNames.add(name);

    let labelText =
      $(`label[for="${$(el).attr('id')}"]`).text().trim() ||
      $(el).closest('.question, .form-group, .field, div, li').find('label, .title, p, h3, h4, strong').first().text().trim() ||
      $(el).attr('placeholder') ||
      name;

    let options = [];
    let qType = 0;

    if (tag === 'select') {
      qType = 3;
      $(el).find('option').each((_, opt) => {
        const val = $(opt).attr('value') || $(opt).text().trim();
        if (val) options.push(val);
      });
    } else if (typeAttr === 'radio' || typeAttr === 'checkbox') {
      qType = typeAttr === 'radio' ? 2 : 4;
      root.find(`input[name="${name}"]`).each((_, r) => {
        const val = $(r).attr('value') || $(r).parent().text().trim();
        if (val) options.push(val);
      });
    } else if (tag === 'textarea') {
      qType = 1;
    }

    const identityKey = classifyIdentityKey(labelText, options);
    if (identityKey) {
      identityFields.push({
        entryId: name,
        key: identityKey,
        title: labelText,
        description: '',
        type: qType,
        options,
        isRequired: Boolean($(el).attr('required'))
      });
    } else {
      quizQuestions.push({
        id: `q_${idx}`,
        entryId: name,
        question: labelText,
        description: '',
        type: qType,
        options,
        imageUrl: null,
        isRequired: Boolean($(el).attr('required'))
      });
    }
  });

  return {
    platform: 'universal_form',
    formTitle,
    formDesc: `Universal Form (${method})`,
    viewUrl: finalUrl,
    submitUrl,
    method,
    fbzx: '',
    pageCount: 1,
    identityFields,
    quizQuestions
  };
}

/**
 * Helper: Panggil AI (xKiro API - mistralai/mistral-large-4-0)
 */
async function solveWithAI({ questions, essayStyle, extraContext, aiModel, customApiKey }) {
  const apiKey = (customApiKey || DEFAULT_API_KEY).trim();
  const model = (aiModel || DEFAULT_MODEL).trim();

  const styleInstruction = {
    santai: 'Gunakan gaya bahasa pelajar SMA/SMK yang ringkas, jelas, langsung ke inti, dan tidak terlalu kaku seperti robot.',
    formal: 'Gunakan gaya bahasa buku paket/akademis yang rapi, lengkap, dan sesuai terminologi materi pelajaran.',
    natural: 'Gunakan gaya ketikan HP siswa: kalimat singkat, huruf kecil di awal kalimat tidak masalah, tanpa tanda baca berlebihan.'
  }[essayStyle] || 'Gunakan gaya bahasa pelajar yang ringkas dan jelas.';

  const simplifiedQuestions = questions.map((q, i) => ({
    no: i + 1,
    entryId: q.entryId,
    question: q.question,
    description: q.description || undefined,
    type: q.type,
    options: q.options && q.options.length > 0 ? q.options : undefined,
    imageHint: q.imageUrl ? `Soal ini menyertakan gambar (${q.imageUrl})` : undefined
  }));

  const systemPrompt = `Kamu adalah mesin penjawab soal ujian akademik tingkat tinggi yang 100% akurat.
Tugasmu adalah menjawab seluruh daftar pertanyaan yang diberikan dalam format JSON murni.

ATURAN WAJIB:
1. Untuk soal yang memiliki daftar "options" (Pilihan Ganda / Dropdown / Checkbox):
   - Nilai pada "answer" WAJIB SAMA PERSIS 100% karakter demi karakter dengan salah satu string di dalam "options".
   - JANGAN menambahkan huruf "A. " atau "B. " di depan jawaban kecuali memang tertulis demikian di dalam array "options".
2. Untuk soal Isian Singkat / Esai (tanpa "options"):
   - ${styleInstruction}
3. Sertakan alasan singkat ("reason") 1 kalimat kenapa jawaban tersebut benar.
4. Kembalikan HANYA objek JSON valid tanpa markdown tambahan dengan struktur:
{
  "answers": {
    "entry.xxxxx": {
      "answer": "Teks Jawaban Tepat",
      "reason": "Penjelasan singkat 1 kalimat"
    }
  }
}`;

  const userPrompt = `${extraContext ? `CATATAN / MATERI REFERENSI GURU:\n${extraContext}\n\n` : ''}DAFTAR SOAL UJIAN:\n${JSON.stringify(simplifiedQuestions, null, 2)}`;

  const response = await fetch(XKIRO_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.1
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`xKiro AI API Error (${response.status}): ${errText.substring(0, 250)}`);
  }

  const data = await response.json();
  let rawContent = data.choices?.[0]?.message?.content || '{}';
  rawContent = rawContent.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

  let parsed = {};
  try {
    parsed = JSON.parse(rawContent);
  } catch (e) {
    const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[0]);
    } else {
      throw new Error('Gagal mem-parsing output JSON dari AI.');
    }
  }

  const answersMap = parsed.answers || parsed;
  const normalized = {};

  for (const q of questions) {
    const item = answersMap[q.entryId];
    let ans = item && typeof item === 'object' && 'answer' in item ? item.answer : item;
    const reason = item && typeof item === 'object' && item.reason ? item.reason : 'Dijawab otomatis oleh AI.';

    if (q.options && q.options.length > 0 && typeof ans === 'string') {
      const exactMatch = q.options.find(o => o === ans);
      if (!exactMatch) {
        const fuzzyMatch = q.options.find(
          o => o.toLowerCase().trim() === ans.toLowerCase().trim() ||
               o.toLowerCase().includes(ans.toLowerCase().trim()) ||
               ans.toLowerCase().includes(o.toLowerCase().trim())
        );
        ans = fuzzyMatch || q.options[0];
      }
    }

    normalized[q.entryId] = {
      correctAnswer: ans ?? (q.options?.[0] || '-'),
      reason
    };
  }

  return normalized;
}

/**
 * NATIVE VERCEL SERVERLESS HANDLER
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(200).json({
      success: true,
      message: 'cobalt.tugas Serverless API aktif! Gunakan method POST.'
    });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const urlParts = (req.url || '').split('?')[0].split('/').filter(Boolean);
    const urlAction = urlParts[urlParts.length - 1];
    const action = body.action || (['scan', 'solve', 'submit'].includes(urlAction) ? urlAction : 'scan');

    // =========================================================================
    // 1. ACTION: SCAN FORM DARI URL ATAU RAW HTML
    // =========================================================================
    if (action === 'scan') {
      const { url, rawHtml, cookie } = body;
      let html = rawHtml || '';
      let finalUrl = url || '[https://docs.google.com/forms/d/e/unknown/viewform](https://docs.google.com/forms/d/e/unknown/viewform)';

      if (!html) {
        if (!url) throw new Error('URL tugas wajib diisi.');
        const headers = {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7'
        };
        if (cookie && cookie.trim()) {
          headers['Cookie'] = cookie.trim();
        }

        const fetchRes = await fetch(url.trim(), {
          method: 'GET',
          headers,
          redirect: 'follow'
        });

        finalUrl = fetchRes.url;
        html = await fetchRes.text();
      }

      const isGoogleForm =
        finalUrl.includes('[docs.google.com/forms](https://docs.google.com/forms)') ||
        finalUrl.includes('forms.gle') ||
        html.includes('FB_PUBLIC_LOAD_DATA_') ||
        html.includes('freebirdFormviewerViewFormContent');

      const parsedForm = isGoogleForm
        ? parseGoogleFormHtml(html, finalUrl)
        : parseUniversalFormHtml(html, finalUrl);

      return res.status(200).json({
        success: true,
        data: parsedForm
      });
    }

    // =========================================================================
    // 2. ACTION: SOLVE SOAL DENGAN AI
    // =========================================================================
    if (action === 'solve') {
      const { questions, essayStyle = 'santai', extraContext = '', aiModel, customApiKey } = body;
      if (!questions || !Array.isArray(questions) || questions.length === 0) {
        throw new Error('Tidak ada daftar soal untuk dijawab.');
      }

      const solvedMap = await solveWithAI({
        questions,
        essayStyle,
        extraContext,
        aiModel,
        customApiKey
      });

      return res.status(200).json({
        success: true,
        modelUsed: aiModel || DEFAULT_MODEL,
        solved: solvedMap
      });
    }

    // =========================================================================
    // 3. ACTION: AUTO-SUBMIT KE SERVER FORM
    // =========================================================================
    if (action === 'submit') {
      const {
        platform,
        submitUrl,
        viewUrl,
        method = 'POST',
        pageCount = 1,
        fbzx = '',
        cookie = '',
        payload = {}
      } = body;

      if (!submitUrl) throw new Error('Alamat pengiriman (submitUrl) tidak ditemukan.');

      const formData = new URLSearchParams();

      for (const [entryId, value] of Object.entries(payload)) {
        if (Array.isArray(value)) {
          value.forEach(v => formData.append(entryId, String(v)));
        } else if (value !== undefined && value !== null && String(value).trim() !== '') {
          formData.append(entryId, String(value));
        }
      }

      if (platform === 'google_form') {
        formData.append('fvv', '1');
        const pageHistory = Array.from({ length: Math.max(1, pageCount) }, (_, i) => i).join(',');
        formData.append('pageHistory', pageHistory);
        if (fbzx) {
          formData.append('fbzx', fbzx);
          formData.append('draftResponse', `[null,null,"${fbzx}"]`);
        }
      }

      const headers = {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
        'Referer': viewUrl || submitUrl,
        'Origin': new URL(submitUrl).origin
      };

      if (cookie && cookie.trim()) {
        headers['Cookie'] = cookie.trim();
      }

      const submitRes = await fetch(submitUrl, {
        method,
        headers,
        body: formData.toString(),
        redirect: 'follow'
      });

      const responseHtml = await submitRes.text();
      const editMatch = responseHtml.match(/href="([^"]*edit2=[^"]*)"/i);
      const editResponseUrl = editMatch ? editMatch[1].replace(/&amp;/g, '&') : null;

      const $ = cheerio.load(responseHtml);
      const confirmationText =
        $('.vHW8K, .freebirdFormviewerViewResponseConfirmationMessage').text().trim() ||
        'Tanggapan Anda telah berhasil direkam oleh server.';

      const isLoginBlocked =
        responseHtml.includes('[accounts.google.com/ServiceLogin](https://accounts.google.com/ServiceLogin)') ||
        submitRes.url.includes('accounts.google.com');

      if (isLoginBlocked) {
        throw new Error('Form menolak pengiriman langsung karena butuh sesi Login. Silakan klik tombol [Buka Magic Link] agar langsung tercentang di Chrome kamu!');
      }

      if (!submitRes.ok && submitRes.status >= 400) {
        throw new Error(`Form menolak kiriman (HTTP ${submitRes.status}). Gunakan tombol [Buka Magic Link] untuk mengirim langsung dari Chrome.`);
      }

      return res.status(200).json({
        success: true,
        status: submitRes.status,
        confirmationText,
        editResponseUrl,
        submittedAt: new Date().toISOString()
      });
    }

    return res.status(400).json({ success: false, error: 'Action API tidak dikenali.' });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || 'Terjadi kesalahan pada server.'
    });
  }
}
