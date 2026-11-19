import { EditSettings, OutlineChapter, ProjectRecord, StudioSettings } from '../types/studio';

export const DEFAULT_TTS_STYLE =
  'Calm, natural BBC documentary narration. Serious, warm, and understated, with a steady unhurried pace, never theatrical.';

export const DEFAULT_BANNED_CLICHES: string[] = [
  'Şimdi gelin derinlemesine bakalım',
  'Sadece X değil, aynı zamanda Y',
  'Peki ama neden?',
  'Gelin yakından inceleyelim',
  'Tarihin tozlu sayfalarında',
  'Gelin hep birlikte keşfedelim',
  'İşte tam bu noktada',
  'Kemerlerinizi bağlayın',
  'Şaşırtıcı bir gerçekle karşılaşıyoruz',
  'Özetlemek gerekirse',
];

export const DEFAULT_STUDIO_SETTINGS: StudioSettings = {
  tierMode: 'free',
  freeApiKeysText: '',
  paidApiKey: '',
  pexelsApiKey: '',
  rpmRetryWaitSec: 25,
  interRequestDelaySec: 2,

  scriptModel: 'gemini-3.8-flash',
  ttsModel: 'gemini-3.8-flash-tts',
  ttsVoice: 'Charon',
  ttsStylePrompt: DEFAULT_TTS_STYLE,
  imageModel: 'gemini-nano-banana-2.1',
  imageResolution: '2K',
  visualWorkflowMode: 'manual_free',

  maxChunkSize: 2500,
  normalPauseMs: 400,
  chapterPauseMs: 1200,
  gentleNormalize: true,
  excludeChapterPrefix: true,
};

export const DEFAULT_EDIT_SETTINGS: EditSettings = {
  resolution: '1920x1080',
  fps: 24,
  transitionType: 'crossfade',
  transitionDurationSec: 0.8,
  kenBurnsIntensity: 1.08,
  targetSceneDurationSec: 18,
  bgMusicFileName: 'ambient_documentary_bed.mp3',
  bgMusicVolumeDb: -22,
  bgMusicAutoLoop: true,
  overlayChapterPosition: 'bottom-left',
  overlayChapterBgOpacity: 0.78,
  overlayVerseBgOpacity: 0.84,
  overlayAccentHex: '#D99B26',
  useFasterWhisper: true,
};

export function createEmptyProject(name = 'Yeni Belgesel Projesi'): ProjectRecord {
  const now = Date.now();
  return {
    id: `proj_${now}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    createdAt: now,
    updatedAt: now,
    activeStep: 1,
    topicBrief: {
      topic: '',
      targetMinutes: 40,
      toneAndAngle:
        'BBC belgesel geleneğinde ağırbaşlı, kaynak odaklı, akademik ama akıcı ve izleyiciyi yormayan belgesel anlatımı.',
      sourceNotes: '',
    },
    outline: [],
    rawScript: '',
    bannedCliches: [...DEFAULT_BANNED_CLICHES],
    chunks: [],
    scenes: [],
    editSettings: { ...DEFAULT_EDIT_SETTINGS },
    studioSettings: { ...DEFAULT_STUDIO_SETTINGS },
  };
}

export const DEMO_SCRIPT_TEXT = `[[BOLUM: GİRİŞ — ÇÖLÜN SESSİZ TANIKLARI]]
15.05.1948 sabahı Kudüs çevresindeki taş sokaklarda olağanüstü bir hareketlilik vardı. Ancak asıl hikâye, o günden birkaç ay önce Kumran mağaralarının derinliklerinde (1QIsa-a) bulunan bir küpün içinden çıkmıştı.

Arkeologlar ve dilbilimciler (Dr. John Trever ve Prof. Millar Burrows) parşömenleri ilk kez masaya serdiğinde, karşılarındaki metin yalnızca antik bir belge değildi. Karbon-14 testleri bu yazmaların M.Ö. 2. yüzyıla kadar uzandığını doğruluyordu. Üstelik metinlerin %95'ten fazlası yüzyıllar sonraki kopyalarla şaşırtıcı bir uyum sergiliyordu.

---

### BÖLÜM 1: YAZMANIN HAFIZASI VE İLK PARŞÖMENLER

Antik dünyada bir metni korumak, bugünkü gibi dijital sunuculara yedeklemek değildi. Her harf, kâtibin mürekkebinde ve sabrında yeniden doğardı. 1930'larda yapılan saha araştırmalarında, yaklaşık 5.800'den fazla el yazması parçası (Codex Sinaiticus, P45, P52) tek tek sınıflandırıldı.

Tarihçiler bu dönemi anlatırken özellikle 68-70 yılları arasındaki büyük kırılmaya dikkat çeker. Papa II. Urbanus döneminden asırlar önce bile, kutsal metinlerin nasıl derlendiği sorusu Akdeniz havzasının en çetin tartışmalarından biriydi.

[[ETIKET: Hûd:114 ve İsrâ:78]]

Bu tarihsel süreçte (özellikle erken dönem tefsir ve rivayet geleneğinde) sözlü kültür ile yazılı kayıt arasındaki ince denge belirleyici oldu.

---

BÖLÜM iki: KAVRAM KARMAŞASI — HANGİ KİTAPTAN BAHSEDİYORUZ?

Modern okur "kitap" kelimesini duyduğunda aklına ciltli, kapaklı ve tek seferde basılmış bir nesne gelir. Oysa 7. yüzyıl Hicaz toplumunda kitap kelimesi yalnızca mürekkep ve kâğıdı değil, bağlayıcı ilahi yasayı ve bütüncül vahyi ifade ediyordu.

[[AYET: En'âm:38 | Biz kitapta hiçbir şeyi eksik bırakmadık.]]

İşte kavram karmaşası tam burada başlar. Bazı yorumcular bu ifadeyi yalnızca yazılı mushafın sınırlarına indirgerken, klasik dönem âlimlerinin büyük bir kısmı (ö. 750 sonrası erken tabakat metinleri dahil) burada kastedilenin evrensel ilahi kayıt olduğunu vurgular.

Örneğin 22:43-44 pasajlarında ve 24-26. ayetlerinde kullanılan dil, tek bir nesneden çok yaşayan bir hitaba işaret eder. Hz. Osman döneminde çoğaltılan nüshalar 138.000 kilometrekareyi aşan yeni coğrafyalara ulaştırıldığında, ortalama 3.5 ay süren kervan yolculukları sonunda aynı metin farklı şehirlerde aynı sesle okunuyordu.

Sonuç olarak, bir metni anlamak için önce onun kendi dönemindeki kavram dünyasına kulak vermek gerekir. Hype'layarak anlatılan yüzeysel iddiaların ötesinde, sakin ve sabırlı bir okuma bizi gerçeğe çok daha fazla yaklaştırır.`;

export const DEMO_OUTLINE: OutlineChapter[] = [
  {
    id: 'demo_ch_0',
    kind: 'cold_open',
    title: 'GİRİŞ — ÇÖLÜN SESSİZ TANIKLARI',
    hook: '1948 baharında Kumran mağaralarından çıkan bir küp, antik metin tarihine bakışımızı nasıl değiştirdi?',
    summaryPoints:
      'Kumran keşfi, Karbon-14 tarihlemesi, sözlü ve yazılı gelenek arasındaki köprü.',
    draftText: DEMO_SCRIPT_TEXT.split('---')[0].trim(),
    writtenAt: Date.now(),
  },
  {
    id: 'demo_ch_1',
    kind: 'chapter',
    number: 1,
    title: 'YAZMANIN HAFIZASI VE İLK PARŞÖMENLER',
    hook: 'Matbaadan binlerce yıl önce bir metin, kıtalar boyunca bozulmadan nasıl taşındı?',
    summaryPoints:
      'El yazması sınıflandırması, 68-70 dönemi kırılması, erken yazılı kayıtlar ve Hûd:114 / İsrâ:78 bağlamı.',
    draftText: DEMO_SCRIPT_TEXT.split('---')[1].trim(),
    writtenAt: Date.now(),
  },
  {
    id: 'demo_ch_2',
    kind: 'chapter',
    number: 2,
    title: 'KAVRAM KARMAŞASI — HANGİ KİTAPTAN BAHSEDİYORUZ?',
    hook: '7. yüzyılda "kitap" kelimesi bugün anladığımız ciltli nesneden ne kadar farklıydı?',
    summaryPoints:
      'En’âm:38 bağlamı, kavramsal çerçeve, Hz. Osman nüshaları ve tarihsel okuma metodolojisi.',
    draftText: DEMO_SCRIPT_TEXT.split('---')[2].trim(),
    writtenAt: Date.now(),
  },
];

export function populateDemoData(base: ProjectRecord): ProjectRecord {
  const now = Date.now();
  return {
    ...base,
    name: 'Demo — Antik Metinler ve Kavram Karmaşası',
    updatedAt: now,
    topicBrief: {
      topic: 'Antik Kutsal Metinlerin Yazıya Geçişi ve Kavram Karmaşası',
      targetMinutes: 35,
      toneAndAngle:
        'BBC belgesel üslubu: abartısız, tarihsel kanıtlara ve kavramsal analize dayanan, sakin ve derinlikli anlatım.',
      sourceNotes:
        'Kumran yazmaları (1QIsa-a), Karbon-14 bulguları, En’âm:38, Hûd:114, İsrâ:78, Hz. Osman dönemi istinsah süreci.',
    },
    outline: DEMO_OUTLINE.map((c) => ({ ...c })),
    rawScript: DEMO_SCRIPT_TEXT,
    chunks: [],
    scenes: [],
  };
}
