import { GoogleGenAI, Modality } from "@google/genai";
import { Resolution, AspectRatio, VideoMode, UserProfile } from "../types";
import { translate } from "../i18n";

// --- HELPERS ---
const getRawBase64 = (base64String: string) => {
  if (!base64String) return "";
  const parts = base64String.split(',');
  return parts.length > 1 ? parts[1] : parts[0];
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const getRandomDelay = () => Math.floor(Math.random() * (8000 - 5000 + 1) + 5000);

const fetchVideoAsBlobUrl = async (uri: string, apiKey: string): Promise<string> => {
  try {
    const response = await fetch(uri, {
      method: 'GET',
      headers: { 'x-goog-api-key': apiKey },
    });
    if (!response.ok) throw new Error("Network error.");
    const blob = await response.blob();
    return URL.createObjectURL(blob);
  } catch (err) {
    console.error("Fetch blob failed:", err);
    const separator = uri.includes('?') ? '&' : '?';
    return `${uri}${separator}key=${apiKey}`; 
  }
};

// --- VIDEO GENERATION (VEO) ---
export interface VeoRequest {
  mode: VideoMode;
  prompt: string;
  resolution: Resolution;
  aspectRatio: AspectRatio;
  images?: string[]; 
  previousVideo?: any; 
  negativePrompt?: string;
  onProgress?: (msg: string) => void;
  customApiKey?: string;
  profile?: UserProfile;
  lang?: 'EN' | 'VN';
  apiKeys?: string[];
  useProjectKey?: boolean;
}

export const generateVeoVideo = async ({
  mode, prompt, resolution, aspectRatio, images = [], previousVideo, onProgress, lang = 'EN', apiKeys = [], useProjectKey = true
}: VeoRequest): Promise<any> => {
  const customKey = sessionStorage.getItem('veopro_custom_key');
  const defaultKey = process.env.API_KEY;
  let allKeys: string[] = [];

  if (useProjectKey) {
    if (defaultKey) allKeys.push(defaultKey);
    const pro1 = process.env.GOOGLE_KEY_PRO1;
    const pro9 = process.env.GOOGLE_KEY_PRO9;
    if (pro1) allKeys.push(pro1);
    if (pro9) allKeys.push(pro9);
  } else {
    allKeys = [...apiKeys];
    if (customKey && !customKey.startsWith('GOOGLE_KEY_')) allKeys.unshift(customKey);
  }
  
  let uniqueKeys = Array.from(new Set(allKeys)).filter(k => k && k.trim() !== '' && !k.includes('GOOGLE_KEY_'));
  if (uniqueKeys.length === 0 && defaultKey) uniqueKeys = [defaultKey];
  if (uniqueKeys.length === 0) throw new Error("API Key missing.");

  let lastError: any = null;
  for (let i = 0; i < uniqueKeys.length; i++) {
    const apiKey = uniqueKeys[i];
    const ai = new GoogleGenAI({ apiKey });
    const model = (mode === VideoMode.CONSISTENCY || previousVideo) ? 'veo-3.1-generate-preview' : 'veo-3.1-fast-generate-preview';
    onProgress?.(`${translate('PROGRESS_INIT', lang)} (Key ${i + 1}/${uniqueKeys.length})`);

    let apiAspectRatio: "16:9" | "9:16" | "1:1" = "16:9";
    if (aspectRatio === AspectRatio.PORTRAIT) apiAspectRatio = "9:16";
    else if (aspectRatio === AspectRatio.SQUARE) apiAspectRatio = "1:1";

    try {
      const maxRetries = uniqueKeys.length > 1 ? 1 : 3;
      let retryCount = 0;

      const executeWithRetry = async (fn: () => Promise<any>): Promise<any> => {
        try { return await fn(); } catch (error: any) {
          if (retryCount < maxRetries) {
            retryCount++;
            await sleep(2000 * retryCount);
            return await executeWithRetry(fn);
          }
          throw error;
        }
      };

      let operation;
      if (previousVideo) {
        operation = await executeWithRetry(() => ai.models.generateVideos({ model: 'veo-3.1-generate-preview', prompt, video: previousVideo, config: { numberOfVideos: 1, resolution, aspectRatio: apiAspectRatio } }));
      } else {
        operation = await executeWithRetry(() => ai.models.generateVideos({ model, prompt, config: { numberOfVideos: 1, resolution, aspectRatio: apiAspectRatio } }));
      }

      while (!operation.done) {
        await sleep(8000);
        operation = await ai.operations.getVideosOperation({ operation });
        onProgress?.(translate('PROGRESS_RENDERING', lang));
      }
      const videoRef = operation.response?.generatedVideos?.[0]?.video;
      const blobUrl = await fetchVideoAsBlobUrl(videoRef.uri, apiKey);
      return { finalUrl: blobUrl, videoRef: videoRef };
    } catch (error) { lastError = error; continue; }
  }
  throw lastError;
};

// --- TEXT GENERATION ---
export const generateGeminiText = async (prompt: string, systemInstruction: string, apiKeys: string[], lang: 'EN' | 'VN' = 'EN', useProjectKey: boolean = true): Promise<string> => {
  const customKey = sessionStorage.getItem('veopro_custom_key');
  const defaultKey = process.env.API_KEY;
  let allKeys: string[] = [];

  if (useProjectKey) {
    if (defaultKey) allKeys.push(defaultKey);
    for (let i = 1; i <= 20; i++) {
      const key = process.env[`GOOGLE_KEY_PRO${i}`];
      if (key) allKeys.push(key);
    }
  } else {
    allKeys = [...apiKeys];
    if (customKey && !customKey.startsWith('GOOGLE_KEY_')) allKeys.unshift(customKey);
  }

  const finalKeys = Array.from(new Set(allKeys)).filter(k => k && k.trim() !== '' && !k.includes('GOOGLE_KEY_'));
  let lastError: any = null;

  for (const apiKey of finalKeys) {
    const ai = new GoogleGenAI({ apiKey });
    try {
      const response = await ai.models.generateContent({
        model: 'gemini-2.0-flash', // Model text ổn định nhất cho bản free/pro
        contents: prompt,
        config: { systemInstruction }
      });
      return response.text || "";
    } catch (error) { lastError = error; continue; }
  }
  throw lastError;
};

// --- IMAGE GENERATION (FREE ENGINE - POLLINATIONS) ---
export const generateGeminiImage = async (
  prompt: string, 
  systemInstruction: string, 
  apiKeys: string[], 
  aspectRatio: "16:9" | "9:16",
  refImage?: string,
  lang: 'EN' | 'VN' = 'EN',
  useProjectKey: boolean = true
): Promise<string> => {
  const width = aspectRatio === "16:9" ? 1280 : 720;
  const height = aspectRatio === "16:9" ? 720 : 1280;
  const seed = Math.floor(Math.random() * 1000000);
  const encodedPrompt = encodeURIComponent(prompt);
  
  // Trả về Engine Free, không cần Key, không lo lỗi 429
  const imageUrl = `https://pollinations.ai/p/${encodedPrompt}?width=${width}&height=${height}&seed=${seed}&model=flux&nologo=true`;
  console.log("🚀 Engine Image Free Activated");
  return imageUrl;
};

// --- VOICE GENERATION (TTS) ---
export const generateGeminiVoice = async (
  text: string, voiceLang: string, voiceGender: 'MALE' | 'FEMALE', voiceStyle: string, apiKeys: string[], outputLanguage: 'EN' | 'VN', useProjectKey: boolean = true, voiceQuality?: string, activeTopic?: string
): Promise<string> => {
  const customKey = sessionStorage.getItem('veopro_custom_key');
  const defaultKey = process.env.API_KEY; // Đã thêm khai báo thiếu
  let allKeys: string[] = [];

  if (useProjectKey) {
    const envKeys = (process.env.GOOGLE_API_KEYS || "").split(",").map(k => k.trim()).filter(Boolean);
    allKeys.push(...envKeys);
    if (defaultKey) allKeys.push(defaultKey);
  } else {
    allKeys = [...apiKeys];
    if (customKey && !customKey.startsWith('GOOGLE_KEY_')) allKeys.unshift(customKey);
  }

  const finalKeys = Array.from(new Set(allKeys)).filter(k => k && k.trim() !== '' && !k.includes('GOOGLE_KEY_'));
  
  // Logic xử lý TTS ...
  const promptText = `Read this in ${voiceLang}: ${text}`; // Đơn giản hóa prompt để tránh lỗi

  for (const apiKey of finalKeys) {
    const ai = new GoogleGenAI({ apiKey });
    try {
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-preview-tts", // Model chuẩn bạn yêu cầu
        contents: [{ parts: [{ text: promptText }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceGender === 'MALE' ? 'Fenrir' : 'Kore' } }
          }
        }
      });
      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (base64Audio) return base64Audio;
    } catch (error) { continue; }
  }
  throw new Error("Voice generation failed.");
};
