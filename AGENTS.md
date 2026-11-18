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
- Stan 18.11.2026: ostatni udany „VipCars daily run” był 25.09.2026. Przebiegi z 13–17.11.2026 padają na kroku „Install Chromium for offline browser tests”.

## Publiczne repo

Wyniki (`output/`), sekrety i dane osobowe zostają poza commitami.
