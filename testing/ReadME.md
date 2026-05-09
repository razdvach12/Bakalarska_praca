# Testovanie UI Control Agenta

Tento priecinok obsahuje podklady a vysledky testovania agenta ovladajuceho webove pouzivatelske rozhranie. Testovanie overovalo, ci agent dokaze na realnych webovych strankach samostatne navigovat, vyhladavat informacie, vyplnat formulare, pracovat s kosikom, reagovat na prekryvacie okna a riesit zlozitejsie filtrovacie alebo dopravne rozhrania.

Podklady vychadzaju zo suborov:

- `BP_Testovacie_Scenare_Final.docx` - navrh metodiky a detailny opis testovacich scenarov
- `Vysledky_testovania.xlsx` - tabulkove vysledky jednotlivych behov a suhrnne statistiky
- `../project/runs/final_testing/` - vystupy z jednotlivych behov, hlavne `summary.json` a screenshoty

## Ciel testovania

Cielom testovania bolo overit robustnost, presnost a prakticku pouzitelnost UI agenta na beznych produkcnych webovych strankach. Testovanie neprebiehalo na umelo pripravenom benchmarku, ale na realnych weboch s beznymi prekazkami, ako su cookie bannery, newsletter popupy, dynamicke filtre, autocomplete polia, date pickery, rozdielne struktury navigacie a nestabilne alebo pomalsie nacitavanie.

Testovanie sledovalo najma:

- ci agent splni zadanu ulohu bez pomoci cloveka
- kolko krokov potrebuje na dokoncenie ulohy
- kolkokrat musi preplanovat postup
- kolko tokenov spotrebuje
- ci potrebuje slovnu alebo prakticku pomoc cloveka
- v akych situaciach zlyhava a preco

## Metodika

Testovacia sada obsahuje 7 scenarov. Kazdy scenar bol spusteny na 4 roznych webovych strankach a porovnavali sa 3 modely. Spolu teda vzniklo 84 jednotlivych behov

Zakladne podmienky testovania:

| Parameter | Hodnota |
|---|---|
| Pocet scenarov | 7 |
| Weby na scenar | 4 |
| Pocet modelov | 3 |
| Celkovy pocet behov | 84 |
| Prehliadac | Chromium |
| Rozlisenie | 1280x720 |
| Casova zona | Europe/Bratislava |
| Cache | bez cache |
| Casovy limit | 300 sekund |
| Vystupy | screenshoty a `summary.json` |

Testovany beh sa hodnotil binarne ako uspesny alebo neuspesny. Okrem toho sa sledovala aj ciastocna uspesnost podla splnenych subtaskov. Niektore behy dokazali splnit cast ulohy, ale neboli zapocitane ako plny uspech, ak nedodrzali ciel zadania alebo skoncili prilis skoro.

## Testovane modely

| Model | Uspesnost | Priemerny pocet krokov | Priemerna spotreba tokenov |
|---|---:|---:|---:|
| `gpt-4.1` | 22/28, 78,57 % | 9,36 | 113 090,68 |
| `gpt-4o-mini` | 18/28, 64,29 % | 10,36 | 844 555,07 |
| `gemini-2.5-flash` | 18/28, 64,29 % | 10,07 | 145 156,76 |
| Spolu | 58/84, 69,05 % | 9,93 | 374 930,76 |

Najvyssiu uspesnost dosiahol model `gpt-4.1`. Model `gemini-2.5-flash` mal rovnaku uspesnost ako `gpt-4o-mini`, ale podstatne nizsiu priemernu spotrebu tokenov. `gpt-4o-mini` mal v testoch najvyssiu spotrebu tokenov a castejsie potreboval pomoc alebo preplanovanie.

## Prehlad scenarov

| Scenar | Nazov | Narocnost | Hlavna oblast | Uspesnost |
|---|---|---|---|---:|
| S01 | Navigacia a hladanie informacii | nizka | kontaktne udaje, navigacia | 12/12, 100 % |
| S02 | Vyhladanie produktu | stredna | vyhladavanie, kosik | 9/12, 75 % |
| S03 | Vyplnenie kontaktneho formulara | stredna | formulare, vstupne polia | 11/12, 91,67 % |
| S04 | Viackrokovy nakup | vysoka | viac produktov, kosik, postupnost krokov | 7/12, 58,33 % |
| S05 | Dynamicke prekazky | stredna | cookies, popupy, spravodajske weby | 10/12, 83,33 % |
| S06 | Dopravne spojenia | vysoka | autocomplete, datumy, casy, vysledky spojeni | 6/12, 50 % |
| S07 | Filtrovanie nehnutelnosti | vysoka | komplexne filtre, lokalita, cena, zoradenie | 3/12, 25 % |

Uspesnost podla narocnosti:

| Narocnost | Scenare | Uspesnost |
|---|---|---:|
| Nizka | S01 | 12/12, 100 % |
| Stredna | S02, S03, S05 | 30/36, 83,33 % |
| Vysoka | S04, S06, S07 | 16/36, 44,44 % |

Vysledky ukazuju jasny pokles uspesnosti pri naraste narocnosti. Jednoduche navigacne ulohy boli zvladnute spolahlivo, zatial co vysoka narocnost odhalila problemy pri dlhom planovani, praci s dynamickymi komponentmi a presnom vyhodnoteni vysledku.

## Detail scenarov

### S01 - Navigacia a hladanie informacii

Agent mal na webovej stranke najst kontaktnu sekciu a vypisat e-mailovu adresu a telefonne cislo na zakaznicku podporu alebo reklamacie. Testovalo sa, ci sa dokaze zorientovat v hlavnej navigacii, paticke alebo inej casti webu a najst relevantne kontaktne udaje.

Testovane weby:

- `https://www.martinus.sk/`
- `https://metalindustrial.sk/`
- `https://nivy.com/`
- `https://www.fiit.stuba.sk/`

Scenar dopadol najlepsie zo vsetkych testov, s uspesnostou 100 %. Problemy sa objavovali hlavne pri nejednoznacnych kontaktoch, kde web neobsahoval priamo podporu alebo reklamacie, ale iba vseobecne kontaktne udaje.

### S02 - Vyhladanie produktu

Agent mal na e-shope vyhladat knihu "Duna" od Franka Herberta, pridat ju do kosika, otvorit kosik a vypisat cenu. Scenar preveroval vyhladavanie, orientaciu vo vysledkoch, vyber spravneho produktu a kontrolu obsahu kosika.

Testovane weby:

- `https://www.martinus.sk/`
- `https://www.pantarhei.sk/`
- `https://www.megaknihy.sk/`
- `https://www.najlacnejsie-knihy.sk/`

Najcastejsim problemom bolo predcasne ukoncenie ulohy. V niektorych behoch agent vyhodnotil, ze kniha je uz v kosiku, hoci este nebola spravne pridana alebo nebol otvoreny kosik.

### S03 - Vyplnenie kontaktneho formulara

Agent mal najst kontaktny formular a vyplnit testovacie udaje. Formular sa nemal odoslat, iba zobrazit vyplneny.

Pouzite testovacie udaje:

- meno: Andrea Vyskusalova
- e-mail: `a.vyskusalova@testujem.sk`
- sprava: testovacia sprava pre scenar S03

Testovane weby:

- `https://nivy.com`
- `https://eurovea.sk/`
- `https://aupark-bratislava.sk/`
- `https://www.borymall.sk/sk/`

Scenar mal vysoku uspesnost 91,67 %. Rizikom bolo hlavne to, ze agent sa po vyplneni formulara niekedy posunul na inu podstranku alebo zacal interpretovat stav formulara nepresne.

### S04 - Viackrokovy nakup

Agent mal vyhladat knihu od Franka Herberta, vlozit ju do kosika, nasledne najst dalsiu sci-fi knihu a tiez ju pridat do kosika. Na konci mal otvorit kosik.

Testovane weby:

- `https://www.martinus.sk/`
- `https://www.megaknihy.sk/`
- `https://www.pantarhei.sk/`
- `https://www.knihyprekazdeho.sk/`

Tento scenar uz vyzadoval dlhsiu postupnost krokov a priebezne udrziavanie ciela. Zlyhania vznikali hlavne pri zamene produktu, strate kontextu po prvom pridani do kosika alebo pri nespravnom vyhodnoteni finalneho stavu.

### S05 - Dynamicke prekazky

Agent mal na spravodajskom portali najst sekciu ekonomia alebo clanky o ekonomii a vypisat nadpisy prvych troch viditelnych clankov. Pocas navigacie mal ignorovat alebo zavriet cookie, subscribe a newsletter popupy.

Testovane weby:

- `https://www.sme.sk/`
- `https://www.aktuality.sk/`
- `https://www.zive.sk/`
- `https://www.hnonline.sk/`

Scenar preveroval robustnost voci prekryvacim oknam a rusivym prvkom. Uspesnost 83,33 % ukazuje, ze agent tieto prekazky vacsinou zvladol, no stale boli problematicke weby s agresivnejsimi overlaymi alebo zlozitejsou navigaciou.

### S06 - Dopravne spojenia

Agent mal vyhladat dopravne spojenie pre zadany datum a cas. Pri slovenskych strankach islo o spojenie Bratislava - Kuty, pri ceskych strankach Praha - Bratislava. Mal vypisat prve spojenie, ktore pouzivatel stiha, vratane casu odchodu a prichodu.

Testovane weby:

- `https://www.regiojet.sk/`
- `https://www.cd.cz/`
- `https://predaj.zssk.sk/`
- `https://cp.sk/vlakbusmhd/spojenie/`

Tento scenar bol narocny hlavne kvoli autocomplete poliam, vyberu datumu, praci s casom a interpretacii vysledkov. Uspesnost bola 50 %, co ukazuje, ze agent dokazal cast uloh zvladnut, ale zlozite dopravne rozhrania casto viedli k timeoutom alebo nespravnemu rozhodnutiu.

### S07 - Filtrovanie nehnutelnosti

Agent mal na realitnom portali nastavit filtre pre 2-izbovy byt v lokalite Bratislava - Stare Mesto, typ ponuky prenajom, maximalnu cenu 800 EUR mesacne, zoradit vysledky od najnovsich a vypisat prve tri vysledky s nazvom, cenou a rozlohou.

Testovane weby:

- `https://www.nehnutelnosti.sk/`
- `https://reality.sk/`
- `https://www.topreality.sk/`
- `https://www.bezrealitky.sk/`

S07 bol najtazsi scenar s uspesnostou 25 %. Najvacsie problemy sposobovali kombinovane filtre, lokalitne naseptavace, rozne typy UI komponentov a potreba skontrolovat, ci vysledky naozaj zodpovedaju vsetkym zadanym podmienkam.

## Metriky

V subore `Vysledky_testovania.xlsx` su pri kazdom behu sledovane tieto polia:

| Metrika | Popis |
|---|---|
| `Success 0/1` | binarne hodnotenie, ci bola uloha splnena |
| `Completed_Subtasks` | pocet splnenych ciastkovych uloh |
| `Total_Subtasks` | celkovy pocet ciastkovych uloh |
| `Partial_Success` | ciastocna uspesnost behu |
| `Steps` | pocet vykonanych krokov |
| `Replans` | pocet preplanovani pocas behu |
| `Duration_seconds` | cas trvania behu v sekundach |
| `HumanHelp_Verbal` | pocet slovnych napoved od cloveka |
| `HumanHelp_Actions` | pocet realnych zasahov cloveka |
| `Tokens_Total` | celkova spotreba tokenov |
| `Failure_Type` | hlavna klasifikacia vysledku alebo zlyhania |
| `Failure_Subtype` | doplnujuca klasifikacia zlyhania |
| `Final_URL` | URL na konci behu |
| `Final_Verdict` | slovny vysledok behu |
| `Notes` | rucne poznamky k priebehu |

## Typy zlyhani

V testovani sa objavili najma tieto typy problemov:

- `timeout` - agent nestihol ulohu dokoncit v casovom limite
- `unfinished` - agent skoncil pred splnenim celej ulohy
- `selector_safety` alebo `couldnt_find_selector` - problem s vyberom alebo pouzitim prvku na stranke
- `needed_user_critical_help` - uloha vyzadovala zasah cloveka,
- `wrong_decision` - agent nespravne vyhodnotil stav stranky alebo vysledok
- `blocker_loop_guard` - ochrana proti cykleniu zastavila beh
- `timeout + dynamic_selectors` - casovy limit sposobeny dynamickymi alebo nestabilnymi prvkami

Najrizikovejsie boli situacie, kde agent musel kombinovat viacero UI prvkov a nasledne overit, ze vysledok zodpoveda vsetkym podmienkam. Typickym prikladom su realitne filtre, dopravne vyhladavace a viackrokove nakupy.

## Struktura vysledkov

Vystupy jednotlivych behov su ulozene v projekte v priecinku:

```text
project/
+-- runs/
    +-- final_testing/
        +-- S01/
        +-- S02/
        +-- S03/
        +-- S04/
        +-- S05/
        +-- S06/
        +-- S07/
```

Kazdy scenar obsahuje podpriecinky pre testovane modely a v nich podpriecinky pre konkretne weby. Priklad:

```text
runs/final_testing/S01/Gemini/martinus/
```

Typicky obsah jedneho behu:

```text
summary.json
step-000.png
step-001.png
...
final.png
```

Subor `summary.json` obsahuje metadata behu, ciel ulohy, subtasky, finalny verdikt, metriky, informacie o pomoci cloveka, preplanovaniach, self-heal pokusoch a klasifikacii vysledku. Screenshoty zachytavaju priebeh a finalny stav webovej stranky.

## Obsah priecinka

```text
testing/
+-- ReadME.md
+-- BP_Testovacie_Scenare_Final.docx
+-- Vysledky_testovania.xlsx
```

Docx subor sluzi ako opis navrhu testovania a scenarov. Excel subor je hlavny zdroj pre kvantitativne vyhodnotenie. Samotne behy a screenshoty su ulozene v `project/runs/final_testing/`.

## Zhrnutie

Testovanie ukazuje, ze agent spolahlivo zvlada jednoduchsie ulohy zalozene na navigacii, hladani informacii a zakladnom vyplnani formularov. Pri stredne narocnych ulohach je vysledok stale dobry, ale objavuju sa chyby pri predcasnom ukonceni alebo nepresnej kontrole vysledku.

Najvacsie problemy nastavaju pri vysokej narocnosti. Scenare S04, S06 a S07 vyzaduju dlhsi plan, pracu s dynamickymi komponentmi a dosledne overenie finalneho stavu. Prave tam klesa celkova uspesnost na 44,44 %. Najslabsim scenarom je S07, kde komplexne realitne filtre dosiahli len 25 % uspesnost.

Z porovnania modelov vysiel najlepsie `gpt-4.1`, ktory dosiahol najvyssiu uspesnost a zaroven najnizsi priemerny pocet krokov. `gemini-2.5-flash` dosiahol rovnaku uspesnost ako `gpt-4o-mini`, ale s vyrazne nizsou spotrebou tokenov. Celkova uspesnost celej testovacej sady je 69,05 %.

