# Zasady dla agentów (Codex i Claude Code)

Ten plik czytają oba narzędzia; `CLAUDE.md` tylko go importuje. Repozytorium jest publiczne.

## Co uruchamia scalenie

- „VipCars daily run” startuje z `main` codziennie o 16:30: pobiera ceny, przygotowuje rekomendacje stawek do importu (Excel), raport i podsumowanie na Telegram. Scalona zmiana działa od najbliższego przebiegu.
- Push do `main` zmieniający kod, testy, `input/`, konfigurację lub `package*.json` uruchamia też krótki przebieg testowy na żywej stronie (Warszawa, jeden scenariusz).
- Zmiana rekomendacji stawek lub `tools/update_vipcars_rates.py` wpływa na ceny: to wysokie ryzyko.
- `gh workflow run` uruchamiaj tylko na wyraźną prośbę.

## Testy

- Lokalnie: `npm test`; przy zmianach w `tools/` także `npm run test:excel`; pełny zestaw: `npm run test:all`.
- PR nie ma testów na GitHubie, więc o scaleniu decydują testy lokalne; podaj ich wynik w opisie PR.
- Przebiegi z przeglądarką działają na `ubuntu-24.04`: Playwright 1.59.1 nie obsługuje Ubuntu 26.04, na które przeszło `ubuntu-latest` (od 13.11.2026 padała instalacja Chromium).
- Stan 18.11.2026: ostatni w pełni udany „VipCars daily run” był 15.09.2026. Od 26.09.2026 w 90–98% części przebiegu wyszukiwania przekraczają limit 240 s przy pobieraniu kolejnych stron wyników (`network_http_fetch`), mimo kolejnych przeróbek pobierania (26.09–8.10).

## Publiczne repo

Wyniki (`output/`), sekrety i dane osobowe zostają poza commitami.
