<div align="center">

<img src=".github/social-preview.jpg" alt="KeyGate — kendi sunucunuzda çalışan AI API ağ geçidi" width="100%">

<h1>KeyGate</h1>

<p><strong>Sahip olduğunuz her sağlayıcı anahtarının önünde tek bir OpenAI uyumlu API.</strong></p>

<p>Sağlayıcı anahtarlarını havuzlayın, hataları otomatik atlatın, kullanımı ölçün ve bütçe uygulayın — tek bir Node.js servisi ve SQLite ile kendi sunucunuzda.</p>

<p>
  <a href="https://github.com/enis1enis2/KeyGate/actions/workflows/ci.yml"><img src="https://github.com/enis1enis2/KeyGate/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="https://github.com/enis1enis2/KeyGate/releases/latest"><img src="https://img.shields.io/github/v/release/enis1enis2/KeyGate" alt="Son sürüm"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/enis1enis2/KeyGate" alt="MIT lisansı"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white" alt="Node.js 20 veya üzeri">
  <a href="Dockerfile"><img src="https://img.shields.io/badge/docker-ready-2496ED?logo=docker&logoColor=white" alt="Docker hazır"></a>
</p>

<p>
  <a href="https://enis1enis2.github.io/KeyGate/">Canlı demo</a> ·
  <a href="#hızlı-başlangıç">Hızlı başlangıç</a> ·
  <a href="#özellikler">Özellikler</a> ·
  <a href="#api-referansı">API</a> ·
  <a href="#yapılandırma">Yapılandırma</a> ·
  <a href="#geliştirme">Geliştirme</a> ·
  <a href="README.md">English</a>
</p>

</div>

## Genel Bakış

Her AI sağlayıcısı size bir anahtar, bir kota ve yeni bir arıza biçimi daha verir. KeyGate hepsinin
önüne tek bir OpenAI uyumlu uç nokta koyar. Sağlayıcı anahtarları **havuzlara** dönüşür, havuzlar
**istemcilerinizin zaten gönderdiği model adları** olur ve sağlıksız anahtarlar otomatik olarak
devre dışı bırakılıp yerine yenisi seçilir.

Tek bir Fastify servisi ve gömülü SQLite veritabanıdır — Redis, Postgres, yan servis veya harici
kuyruk gerekmez. Resmî OpenAI SDK'sını, LangChain'i, Open WebUI'yi, LlamaIndex'i, n8n'i ya da kendi
ajanınızı ağ geçidinin temel URL'sine yönlendirin; hiçbir değişiklik yapmadan çalışır.

## Özellikler

| Yetenek | Ne yapar |
| :--- | :--- |
| **Tek API, tüm yüzeyler** | `/v1/chat/completions`, `/v1/responses`, `/v1/completions`, `/v1/embeddings`, `/v1/moderations`, `/v1/images/*`, `/v1/audio/*`, `/v1/files`, `/v1/batches`, `/v1/models` ve genel `/v1/passthrough/{provider}/*` rotası aynı hattı paylaşır. |
| **Havuzlar ve yönlendirme** | Havuz, istemcilerin gönderdiği model adıdır. Hedef zinciri ve stratejiyi siz seçersiniz: `weighted-by-health`, `round-robin` veya `priority`. |
| **Sağlık tabanlı yedekleme** | Her sağlayıcı anahtarı için kayan pencere p50/p95 gecikmeyi ve başarı oranını izler. Hatalı anahtarlar üstel geri çekilmeye alınır, üst kaynağın `Retry-After` değeri dikkate alınır, kimlik doğrulama ve kota hatalarında uzun bekleme uygulanır. |
| **Ölçümleme ve bütçeler** | Milyon token başına fiyatlandırma kullanımı maliyete çevirir. Günlük üst sınırlar havuz ve ağ geçidi anahtarı bazında uygulanır; bütçesi dolan anahtarlar üst kaynağa istek gitmeden yönlendirmeden çıkarılır. |
| **Bildirimsel sağlayıcılar** | Sağlayıcılar kod değil YAML/JSON verisidir: uç noktalar, kimlik doğrulama başlıkları, JSONata/Handlebars eşlemeleri, akış parçası dönüşümü ve hata sınıflandırması. |
| **Disk üzerinde şifreleme** | Üst kaynak anahtarları ortam değişkeninden gelen ana anahtarla AES-256-GCM ile şifrelenir. Ham anahtarlar hiçbir zaman günlüğe yazılmaz ve tam olarak döndürülmez. |
| **Yönetim konsolu** | Sabit sol ray (Genel Bakış / Yapılandırma / Erişim / İzleme) üzerinden sağlayıcılar, havuzlar, anahtarlar, fiyatlandırma, istek izleri ve canlı sağlık durumu için React arayüzü. cURL'den tanım üreten sihirbaz ve eşlenmiş istek/yanıtı gösteren test çalıştırıcısı içerir. |
| **Gözlemlenebilirlik** | `/metrics` üzerinde Prometheus metrikleri, maliyetli ve filtrelenebilir istek izleri, hat boyunca taşınan trace kimlikleri ve hassas bilgi sızdırmayan `/healthz` yoklaması. |
| **Varsayılan olarak sıkılaştırılmış** | Yönetim ve veri düzlemi kimlik doğrulaması, sıkı CSP ve güvenlik başlıkları, hız sınırlama, yükleme limitleri, dizin aşımına kapalı passthrough ve kapsamlı model yönlendirmesi. |

## Nasıl çalışır

```text
OpenAI SDK · LangChain · Open WebUI · n8n · curl
                       │
                       │  POST /v1/chat/completions
                       │  Authorization: Bearer kg-live-…
                       ▼
┌────────────────────────────── KeyGate ─────────────────────────────┐
│  1. Ağ geçidi anahtarını doğrula — havuz kapsamı, rpm/tpm, bütçe   │
│  2. Model adını çöz → havuz → hedef zinciri                        │
│  3. Sağlıklı üst kaynak anahtarını seç (weighted / round-robin /   │
│     priority)                                                      │
│  4. İsteği JSONata veya Handlebars ile eşle                        │
│  5. Üst kaynağı çağır, yanıtı akıt, kullanımı ölç                  │
│  6. 429/5xx durumunda: sıradaki anahtarı dene, geri çekil,         │
│     devreyi aç                                                     │
└────────────────────────────────────────────────────────────────────┘
                       │
                       ▼
        OpenAI · Groq · Mistral · Together · DeepSeek · Anthropic · …
```

## Hızlı başlangıç

### Docker Compose (önerilen)

```bash
git clone https://github.com/enis1enis2/KeyGate.git
cd KeyGate

cp .env.example .env
# Gerekli iki sırrı üretip .env dosyasına yazın:
#   KEYGATE_MASTER_KEY=$(openssl rand -hex 32)
#   KEYGATE_ADMIN_TOKEN=$(openssl rand -hex 32)

docker compose up -d --build
```

[http://localhost:3000](http://localhost:3000) adresini açın, yönetim jetonunu girin; ardından bir
sağlayıcı ekleyip havuz oluşturun ve ağ geçidi anahtarı üretin. İlk açılışta başlangıç için bir ağ
geçidi anahtarı konteyner günlüğüne yazılır.

| Servis | URL |
| :--- | :--- |
| Yönetim arayüzü | `http://localhost:3000` |
| OpenAI uyumlu API | `http://localhost:3000/v1` |
| Sağlık yoklaması | `http://localhost:3000/healthz` |
| Prometheus metrikleri | `http://localhost:3000/metrics` |

> [!IMPORTANT]
> İmaj ayrıcalıksız `node` kullanıcısı (uid 1000) olarak çalışır. Linux'ta ilk başlatmadan önce
> bağlanan veri dizinini aynı sahiplikle oluşturun:
> `mkdir -p data && sudo chown -R 1000:1000 data`.
>
> `NODE_ENV=production` iken `KEYGATE_MASTER_KEY` ve `KEYGATE_ADMIN_TOKEN` zorunludur. KeyGate
> eksik, çok kısa veya örnek/placeholder görünen bir sırla açılmayı reddeder.

Ardından herhangi bir OpenAI uç noktası gibi çağırın:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer kg-live-..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "default",
    "messages": [{ "role": "user", "content": "KeyGate'ten merhaba" }]
  }'
```

## Yapılandırma

Yorumlarıyla birlikte tam liste [`.env.example`](.env.example) dosyasındadır. En önemli ayarlar:

| Değişken | Varsayılan | Amaç |
| :--- | :--- | :--- |
| `KEYGATE_MASTER_KEY` | *üretimde zorunlu* | Üst kaynak anahtarlarını diskte şifreleyen AES-256-GCM anahtarı (en az 16 karakter) |
| `KEYGATE_MASTER_KEY_PREVIOUS` | — | Virgülle ayrılmış eski anahtarlar; yalnızca rotasyon sırasında şifre çözmede kullanılır |
| `KEYGATE_ADMIN_TOKEN` | *üretimde zorunlu* | `/api/*` ve `/metrics` için bearer jetonu |
| `KEYGATE_REQUIRE_AUTH` | `true` | `/v1/*` üzerinde ağ geçidi jetonu denetimi (üretimde kapatılamaz) |
| `KEYGATE_DB_PATH` | `./data/keygate.sqlite` | SQLite veritabanı konumu |
| `TRUST_PROXY` | `false` | `true` veya virgülle ayrılmış vekil adresleri/CIDR'lar; ters vekil arkasında doğru istemci IP'si için |
| `CORS_ORIGINS` | *(boş)* | Virgülle ayrılmış izinli kaynaklar; boşsa yalnızca aynı kaynak |
| `RATE_LIMIT_MAX` | `300` | Pencere başına genel istek sınırı |
| `RATE_LIMIT_V1_MAX` | `120` | `/v1/*` için daha sıkı pencere sınırı |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Hız sınırı penceresinin uzunluğu |
| `HISTORY_ENABLED` | `true` | Havuz bazında istem/yanıt geçmişi sakla; paylaşılan kurulumlarda `false` yapın |
| `METRICS_RETENTION_DAYS` | `30` | İstek günlüğü ve metrik saklama süresi |
| `MAX_UPLOAD_BYTES` | `67108864` | Azami multipart yükleme boyutu (64 MiB) |
| `DEFAULT_TIMEOUT_MS` | `30000` | Varsayılan üst kaynak zaman aşımı (havuzlar geçersiz kılabilir) |

### Ana anahtarı döndürme

Rotasyon iki anahtarla yapılır; böylece ağ geçidi çevrimiçi kalır:

1. `openssl rand -hex 32` ile yeni bir anahtar üretin.
2. `KEYGATE_MASTER_KEY` değerini yeni anahtara, `KEYGATE_MASTER_KEY_PREVIOUS` değerini eski
   anahtara ayarlayıp yeniden başlatın. Şifre çözmede iki anahtar da denenir.
3. Tüm satırları yeniden şifreleyin: `cd backend && npm run reencrypt` veya
   `docker compose exec keygate node dist/reencrypt.js`.
4. `KEYGATE_MASTER_KEY_PREVIOUS` değişkenini kaldırıp yeniden başlatın.

Betik idempotenttir, zaten geçerli anahtarda olan satırları atlar ve çözemediği satırları sırları
yazdırmadan bildirir.

## API referansı

### OpenAI uyumlu API (`/v1`)

Her rota `Authorization: Bearer kg-live-...` ister (`KEYGATE_REQUIRE_AUTH=false` olmadıkça) ve bir
AI havuzu üzerinden yönlendirilir.

| Uç nokta | Yöntemler | Açıklama |
| :--- | :--- | :--- |
| `/v1/chat/completions` | `POST` | Sohbet tamamlama — akışlı ve akışsız, yedekleme, hedging |
| `/v1/responses` | `POST` | OpenAI Responses API |
| `/v1/completions` | `POST` | Eski metin tamamlama; kullanım SSE'den geri doldurulur |
| `/v1/embeddings` | `POST` | Maliyet ölçümlü gömme (embedding) |
| `/v1/moderations` | `POST` | İçerik moderasyonu |
| `/v1/images/generations` | `POST` | Görsel üretimi (JSON) |
| `/v1/images/edits`, `/v1/images/variations` | `POST` | Multipart görsel işlemleri; her denemede yeniden serileştirilir |
| `/v1/audio/transcriptions`, `/v1/audio/translations` | `POST` | Multipart ses → JSON |
| `/v1/audio/speech` | `POST` | Ses sentezi (ikili geçiş) |
| `/v1/files`, `/v1/files/{id}`, `/v1/files/{id}/content` | `GET`, `POST` | Dosya yükleme, listeleme ve indirme; oluşturan üst kaynak hesabına sabitlenir |
| `/v1/batches`, `/v1/batches/{id}`, `/v1/batches/{id}/cancel` | `GET`, `POST` | Toplu işler; oluşturan üst kaynak hesabına sabitlenir |
| `/v1/models` | `GET` | Bu ağ geçidi anahtarının kullanabileceği havuzları listeler |
| `/v1/passthrough/{provider}/*` | tümü | Sağlayıcı temel URL'si ve anahtarın havuz kapsamıyla sınırlı ham isteklerde en sağlıklı anahtarı enjekte eder |

### Yönetim API'si (`/api`)

Tüm `/api/*` rotaları ve `/metrics`, `Authorization: Bearer <KEYGATE_ADMIN_TOKEN>` ister. Arayüz
jetonu `sessionStorage` içinde tutar ve sekme kapanınca siler. Sözleşme, rota şemalarından üretilir
ve `GET /api/openapi.json` adresinde OpenAPI 3.1 olarak sunulur.

| Uç nokta | Yöntemler | Açıklama |
| :--- | :--- | :--- |
| `/api/providers` | `GET`, `POST` | Bildirimsel sağlayıcı tanımlarını listele ve kaydet |
| `/api/providers/wizard/draft` | `POST` | cURL komutundan sağlayıcı tanımı taslağı üret |
| `/api/providers/test` | `POST` | Eşlenmiş isteği ve yanıtı gösteren canlı test çalıştırıcısı |
| `/api/keys` | `GET`, `POST`, `PUT`, `DELETE` | Şifreli üst kaynak anahtarları, sağlık metrikleri, günlük bütçeler |
| `/api/aliases` | `GET`, `POST`, `DELETE` | Havuzlar: hedef zinciri, strateji, uç nokta ipucu, günlük üst sınırlar |
| `/api/pricing` | `GET`, `POST`, `DELETE` | `model_pricing` satırları (milyon token başına USD) |
| `/api/gateway-keys` | `GET`, `POST`, `DELETE` | rpm/tpm limitleri ve havuz kapsamıyla istemci bearer jetonu üret ve iptal et |
| `/api/logs` | `GET` | Durum, sağlayıcı, model, uç nokta ve maliyetle filtrelenebilir istek izleri |
| `/api/dashboard/stats` | `GET` | KPI'lar, bugünkü harcama, havuz bazlı kullanım ve bütçesi dolan anahtarlar |

## Sağlayıcı tanımları

Sağlayıcılar kod değil yapılandırmadır. [`providers/`](providers) dizininde iki çalışan örnek
bulunur:

- [`openai-compatible.yaml`](providers/openai-compatible.yaml) — Groq, Together, DeepSeek, Mistral
  ve diğer OpenAI uyumlu API'ler için hızlı yol.
- [`anthropic-messages.yaml`](providers/anthropic-messages.yaml) — bilinçli olarak standart dışı bir
  API; çift yönlü JSONata eşlemesini, akış parçası dönüşümünü ve özel hata türlerini gösterir.

Kendi tanımınızı YAML yazarak ekleyin veya bir cURL komutunu **Sağlayıcı Ekle** sihirbazına
yapıştırıp taslağı otomatik üretin.

## Entegrasyonlar

KeyGate OpenAI protokolünü konuşur; özel temel URL kabul eden her istemci değişiklik yapmadan
çalışır.

| İstemci | Kılavuz |
| :--- | :--- |
| OpenAI SDK (Python / Node) | [docs/integrations.md](docs/integrations.md) |
| LangChain | [docs/integrations.md](docs/integrations.md) |
| Open WebUI | [docs/integrations.md](docs/integrations.md) |
| n8n | [docs/n8n.md](docs/n8n.md) ve [`n8n-example.json`](n8n-example.json) |
| Home Assistant | [homeassistant/custom_components/keygate](homeassistant/custom_components/keygate/README.md) |
| cURL / herhangi bir HTTP istemcisi | [docs/integrations.md](docs/integrations.md) |

## Geliştirme

### Gereksinimler

- Node.js 20 veya üzeri (CI 22 kullanır; konteyner imajı 26 içerir)
- npm 10 veya üzeri

```bash
# Ön yüz — backend/public içine derler
cd frontend
npm install
npm run build

# Arka uç — derlenmiş arayüzü :3000 üzerinde sunar
cd ../backend
npm install
npm run build
npm start
```

### Kontroller

```bash
# Arka uç
cd backend
npm run typecheck   # src/ ve tests/ için tsc
npm run lint        # oxlint
npm test            # vitest, izole geçici veritabanı
npm run test:coverage

# Ön yüz
cd frontend
npm run lint
npm test            # vitest + Testing Library (jsdom)
npm run build
```

Testler işletim sisteminin geçici dizininde atılabilir bir SQLite veritabanı kullanır; yerel
`data/` dizininiz hiçbir zaman değişmez. Her iki paket de kapsam eşiğini `vitest.config.ts`
içinde uygular ve CI her push ile pull request'te aynı kontrolleri çalıştırır
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

### Demo derlemesi

GitHub Pages sitesi ayrı bir maket değil, gerçek konsoldur. Bir derleme bayrağı HTTP istemcisini
yalnızca tarayıcıda çalışan sahte bir API ile değiştirir:

```bash
cd frontend
VITE_DEMO=1 VITE_BASE=/KeyGate/ npm run build:demo   # frontend/dist içine yazar
npx serve dist -l 4173                               # http://127.0.0.1:4173/
```

`VITE_DEMO=1` (veya URL'ye `?demo` eklemek) `/api` ve `/v1` isteklerini tohumlanmış bellekten
yanıtlayan bir `fetch` araya giricisi kurar. Arka uca bağlanılmaz, tüm değerler kurgusaldır ve
sayfa yenilendiğinde durum sıfırlanır. Normal `npm run build` değişmez ve `backend/public` içine
yazar. Üretim ve demo aynı kabuğu kullanır: masaüstünde 256 px sabit kenar çubuğu, 1024 px altında
kalıcı (modal) çekmece.

### Uçtan uca ve yük testleri

Her iki takım da **atılabilir, çalışan bir kurulum** ister — veri oluşturur ve gerçek trafik üretir.

```bash
# Playwright: giriş, sekme gezinme, ağ geçidi anahtarı oluştur/iptal et/sil
cd frontend
npm run test:e2e:install
KEYGATE_E2E_URL=http://127.0.0.1:3000 \
KEYGATE_E2E_ADMIN_TOKEN=... \
npm run test:e2e

# k6: SCENARIO=smoke|load|ratelimit|soak
docker run --rm --network host \
  -e BASE_URL=http://127.0.0.1:3000 \
  -e ADMIN_TOKEN=... -e GATEWAY_KEY=kg-live-... -e SCENARIO=soak \
  -v "$PWD/load-tests:/scripts" grafana/k6 run /scripts/keygate.js
```

Yük altında `429` doğru bir yanıttır; ağ geçidi tasarım gereği hız sınırlar. k6 betiği bunu kabul
eder; sınırlayıcının devreye girdiğini kanıtlamak için `ratelimit` senaryosunu çalıştırın, ham
aktarım hızı ölçmek için atılabilir kurulumda limitleri yükseltin. Bu takımları asla üretime
yönlendirmeyin.

## Güvenlik

- **Diskte şifreleme** — benzersiz IV ve kimlik doğrulamalı etiketlerle AES-256-GCM; anahtarlar
  `önek...sonek` biçiminde maskelenir ve günlüğe yazılmaz.
- **Yönetim kimlik doğrulaması** — `/api/*` ve `/metrics`, bearer jetonunu normalize edilmiş yol
  üzerinde `crypto.timingSafeEqual` ile karşılaştırır.
- **Kimlik doğrulaması önce gelen veri düzlemi** — `/v1/*` jetonları, istek gövdesi ayrıştırılmadan
  veya tamponlanmadan önce bir `onRequest` kancasında denetlenir.
- **Hızlı başarısız sırlar** — üretim, eksik, zayıf veya örnek görünen sırlarla açılmayı reddeder.
- **Gönderim öncesi kotalar** — rpm/tpm slotları, havuz üst sınırları ve anahtar bütçeleri üst
  kaynak çağrısından önce denetlenir; ihlaller `Retry-After` ile `429 quota_exhausted` döner.
- **Güvenlik başlıkları** — sıkı CSP, `nosniff`, `DENY`, `no-referrer`, COOP/CORP, izin politikası
  ve üretimde HSTS.
- **Passthrough sıkılaştırması** — yalnızca izinli başlıklar, dizin aşımı reddi (kodlanmış noktalar
  dahil), kaynak sabitleme ve havuz kapsamı denetimi.
- **Kapsamlı yönlendirme** — bilinmeyen modeller sessizce ilk sağlayıcıya düşmek yerine
  `404 model_not_found` döner.
- **Saklama** — istek izleri ve metrikler `METRICS_RETENTION_DAYS` sonunda temizlenir; istem/yanıt
  geçmişi `HISTORY_ENABLED=false` ile kapatılabilir.

Tam tehdit modeli ve bildirim süreci için [`SECURITY.md`](SECURITY.md) dosyasına bakın.

## Dokümantasyon

| Belge | İçerik |
| :--- | :--- |
| [Canlı demo](https://enis1enis2.github.io/KeyGate/) | Tarayıcı içi sahte API ile gerçek konsol (`frontend/src/demo/`) — arka uç yok, yenilemede sıfırlanır |
| [`memory-bank/`](memory-bank/) | İşletim el kitabı: proje, iş akışları, araçlar, runbook |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Geliştirme kurulumu, kod kuralları, pull request süreci |
| [`SECURITY.md`](SECURITY.md) | Güvenlik mimarisi, bildirim politikası, anahtar rotasyonu |
| [`DECISIONS.md`](DECISIONS.md) | Mimari ve mühendislik kararları |
| [`docs/integrations.md`](docs/integrations.md) | OpenAI SDK, LangChain, Open WebUI ve genel istemciler |
| [`docs/n8n.md`](docs/n8n.md) | n8n iş akışı kurulumu |
| [`report.md`](report.md) | Güvenlik ve kalite denetimi, düzeltme durumuyla birlikte |
| [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) | Topluluk kuralları |

## Katkıda bulunma

Katkılar memnuniyetle karşılanır. Önce [`CONTRIBUTING.md`](CONTRIBUTING.md) dosyasını okuyun ve
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) kurallarına uyun.

Güvenlik açığı mı buldunuz? **Herkese açık bir issue açmayın** — [`SECURITY.md`](SECURITY.md)
içindeki bildirim sürecini izleyin.

## Lisans

[MIT Lisansı](LICENSE) altında yayımlanmıştır.
