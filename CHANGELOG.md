# Changelog

Tüm önemli değişiklikler bu dosyada tutulur.

Format [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) standardına, sürüm numarası [Semantic Versioning](https://semver.org/spec/v2.0.0.html) kuralına uyar.

## [Unreleased]

### Eklendi

- Stripe credential capture (planlanan)
- Chrome Web Store listing (planlanan)

## [0.1.0] - 2026-04-24

İlk sürüm.

### Eklendi

- App Store Connect akışı: Bundle ID ve App-Specific Shared Secret yakalama (Manage dialog, yoksa Generate), API key üretimi ve `.p8` dosyasının `URL.createObjectURL` hook'u ile yakalanması
- Google Cloud akışı: proje seçici vurgulama, Google Play Android Developer ve Developer Reporting API'lerinin enable edilmesi, Pub/Sub Admin ve Monitoring Viewer rollerinde service account oluşturma, JSON key üretimi ve yakalama
- Play Console invite akışı: service-account email girişi, 7 gerekli iznin debug-id ile işaretlenmesi, davet gönderimi ve onay
- Adapty onboarding paneli: `app.adapty.io/onboarding` üzerine shadow DOM tabanlı panel enjeksiyonu, React native setter ile form doldurma, `DataTransfer` ile `.p8` ve JSON dosyalarının dropzone'lara yüklenmesi
- `chrome.storage.session` üzerinde state yönetimi, tarayıcı kapanınca otomatik temizlenir
- Toolbar popup: yakalanan credential durumu ve "Clear captured credentials" kısayolu
- Adapty mor (#7018FF) renk teması, shadow DOM tabanlı overlay ve page dimmer
