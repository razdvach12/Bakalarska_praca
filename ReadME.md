# Bakalarska praca - UI Control Agent

**Student:** David Vach  
**Skola:** Slovenska technicka univerzita v Bratislave, FIIT STU  
**Tema:** Agent ovladajuci pouzivatelske rozhranie pre pouzivatelske testovanie  
**Rok:** 2026

## Zadanie prace

> Agent ovládajúci používateľské rozhranie (angl. UI Control Agent) je inovatívna technológia založená na AI modeloch, ktorá zastupuje interakciu človeka s používateľskými rozhraniami (aplikáciami). Podobne ako človek agent plní cieľovú úlohu autonómnou interakciou 
>s používateľským rozhraním - kliknutím na tlačidlá, posúvaním obrazovky, zadávaním textu alebo výberom možností v menu. Súčasný výskum sa zameriava na využitie veľkých jazykových modelov (LLMs) na vývoj agentov, ktorí dokážu vykonávať úlohy definované používateľmi. Integrácia agentov do testovania použiteľnosti prináša príležitosti na efektívnejšie a rýchlejšie hodnotenie použiteľnosti aplikácií. Agenti dokážu simulovať správanie používateľov, vykonávať bežné úlohy a generovať podrobné údaje o interakciách, ktoré slúžia na zlepšenie dizajnu. Môžu byť mimoriadne užitoční pri iteratívnom vývoji a optimalizácii použiteľnosti. Napriek rýchlemu pokroku zostáva presnosť agentov relatívne nízka bez dodatočného doladenia na úlohách so špecifickými demonštráciami (angl. task-specific demonstrations).

>Analyzujte súčasný stav v danej oblasti pričom sa zamerajte na otvorené výzvy. Navrhnite a implementujte riešenie agenta ovládajúceho používateľské rozhranie v prostredí webu, príp. v prostredí mobilných aplikácií. Riešenie overte na vybraných netriviálnych úlohách a demonštrujte robustnosť riešenia.

## Ciele prace

Hlavne ciele prace:

- analyzovat aktualny stav v oblasti agentov ovladajucich pouzivatelske rozhranie,
- identifikovat otvorene vyzvy pri pouziti tychto agentov na realnych webovych strankach,
- navrhnut architekturu weboveho UI agenta s podporou pozorovania, rozhodovania, validacie, vykonania akcie a overenia vysledku,
- implementovat riesenie nad Playwrightom,
- overit riesenie na netrivialnych ulohach z realneho weboveho prostredia,
- porovnat viacero modelov za rovnakych podmienok,
- vyhodnotit uspesnost, naklady, potrebu pomoci cloveka a typicke dovody zlyhania.

## Strucny suhrn riesenia

Implementovany agent prijima prirodzene formulovanu ulohu, napr. najst kontaktne udaje, pridat produkt do kosika, vyplnit formular alebo nastavit filtre na realitnom portali. Po spusteni si vytvori strukturovany ciel, pozoruje aktualny stav webovej stranky a v cykle navrhuje jednotlive akcie.

Zakladne vlastnosti riesenia:

- webove ovladanie cez Playwright
- praca so strukturovanym DOM snapshotom
- doplnkova vizualna kontrola pre prekryvacie okna a problematicke stavy
- validacia akcii pred vykonanim
- overovanie, ci akcia realne zmenila stav stranky
- replanovanie pri stagnacii alebo nespravnom postupe
- self-heal mechanizmy pred poziadanim o pomoc cloveka
- ukladanie screenshotov a metrik do `summary.json`

## Vyhodnotenie

Riesenie bolo testovane na 7 scenaroch narastajucej narocnosti, kazdy na 4 realnych webovych strankach a s 3 modelmi. Spolu bolo vykonanych 84 behov.

Hlavne vysledky testovania:

- celkova uspesnost: 58/84 behov, teda 69,05 %
- najlepsi model: `gpt-4.1` s uspesnostou 78,57 %
- `gpt-4o-mini` a `gemini-2.5-flash` dosiahli rovnaku uspesnost 64,29 %
- jednoduche navigacne ulohy boli zvladnute spolahlivo
- najtazsie boli komplexne filtre, dopravne vyhladavace a dlhsie viackrokove ulohy
- najcastejsie problemy suviseli s dynamickymi UI prvkami, timeoutmi
nespravnym vyhodnotenim stavu a zlozitymi overlaymi

Detailne testovacie scenare a vysledky su opisane v priecinku `testing/`.

## Struktura repozitara

```text
Bakalarska_praca/
+-- ReadME.md
+-- requirements.txt
+-- project/
    +-- src/
    +-- runs/
    +-- monitor-ui/
    +-- playwright/
    +-- package.json
    +-- run.ts
+-- testing/
    +-- ReadME.md
    +-- BP_Testovacie_Scenare_Final.docx
    +-- Vysledky_testovania.xlsx
```

## Dolezite casti

- `project/src/` - zdrojovy kod agenta a jeho pomocnych modulov
- `project/run.ts` - vstupny skript na spustenie agenta
- `project/runs/final_testing/` - ulozene behy finalneho testovania
- `testing/ReadME.md` - detailny opis metodiky, scenarov a vysledkov testovania
- `testing/Vysledky_testovania.xlsx` - tabulkove vyhodnotenie vsetkych behov
- `testing/BP_Testovacie_Scenare_Final.docx` - opis testovacich scenarov

## Spustenie projektu

Projekt je implementovany v Node.js/TypeScripte

Instalacia zavislosti:

```bash
npm install
```

Spustenie agenta:

```bash
npm run run:ui
```

Spustenie API pocas vyvoja:

```bash
npm run dev:api
```

Spustenie Mastra dev prostredia:

```bash
npm run dev
```

## Poznamka

Repozitar obsahuje implementaciu, testovacie scenare a vysledky experimentov k bakalarskej praci. Vystupy testovania su zalozene na realnych webovych strankach, ktore sa mozu casom menit, preto jednotlive behy nemusia byt plne deterministicke.
