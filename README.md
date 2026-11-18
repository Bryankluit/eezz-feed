# EEZZ → Meta-hotelfeed

Maakt een XML-feed voor een **Meta-hotelcatalogus** (Advantage+-catalogusadvertenties voor reizen) met alle accommodaties van eezz.nl.

## Waarom een hotelcatalogus (en geen productcatalogus)

De Meta-pixel van EEZZ (via GTM) stuurt bij `ViewContent` `content_type: "hotel"` mee, met als `content_ids` de slug uit de URL (`/accommodaties/<slug>`). De feed gebruikt diezelfde slug als `hotel_id`, zodat Meta bezoekers aan de juiste accommodatie koppelt (retargeting).

## Draaien

```bash
node eezz-meta-feed.mjs              # volledige run (eerste keer ±45 min, daarna sneller)
node eezz-meta-feed.mjs --limit 50   # testrun → output/eezz-meta-hotel-feed.test.xml
node controleer-feed.mjs             # feed controleren op Meta-eisen
```

Je hebt alleen Node.js 18 of hoger nodig, verder geen packages.

## Automatisch (GitHub Actions)

`.github/workflows/eezz-feed.yml` draait dagelijks om 04:00 UTC en is ook met de hand te starten (tab **Actions** → *EEZZ Meta-hotelfeed* → *Run workflow*).

- Een goedgekeurde feed komt als bestand bij de release `feed-eezz`. Feed-URL voor Meta:
  `https://github.com/Bryankluit/eezz-feed/releases/download/feed-eezz/eezz-meta-hotel-feed.xml`
- `rapport.csv` en `samenvatting.json` staan bij dezelfde release.
- Nieuwe adressen (`data/locaties.csv`, `data/geocache.json`) worden teruggecommit. Haal ze dus eerst binnen (`git pull`) voordat je adressen met de hand verbetert.
- Is de feed afgekeurd (exitcode 2) of geeft de controle fouten, dan wordt er niets gepubliceerd, blijft de vorige feed staan en wordt de run rood.

## Waar de gegevens vandaan komen

| Veld | Bron |
|---|---|
| Lijst van accommodaties | sitemap van eezz.nl (alleen items met een echte pagina) |
| Naam, omschrijving, foto's, personen, slaapkamers, huisdieren | boekings-API van EEZZ (`connect.eezz.nl`) |
| Beschikbaarheid | beschikbaarheidskalender per accommodatie, komende 365 dagen |
| `base_price` | laagste "vanaf"-prijs per nacht uit de kalender (huurprijs, zoals EEZZ die zelf als "v.a." toont). Partners zonder kalenderprijs krijgen een offerteprijs (2 volwassenen, totaal ÷ nachten) |
| Adres en coördinaten | per park/plaats opgezocht via OpenStreetMap, opgeslagen in `data/locaties.csv` |

**Let op bij de prijs:** de kalenderprijs is de kale huurprijs. Vaste kosten zoals schoonmaak en linnengoed komen er bij het boeken nog bij. Zo toont EEZZ het ook in de eigen zoekresultaten, maar check met EEZZ of dat zo in advertenties mag.

## Labels voor productsets in Meta

| Veld | Inhoud |
|---|---|
| `custom_label_0` | land (bv. Nederland) |
| `custom_label_1` | regio |
| `custom_label_2` | park |
| `custom_label_3` | personen (1-2, 3-4, 5-6, 7-8, 9+) |
| `custom_label_4` | beschikbaar binnen 30 dagen / beschikbaar na 30 dagen / niet beschikbaar |
| `custom_number_0..3` | max. personen, slaapkamers, huisdieren (1/0), aantal boekbare aankomstdagen |
| `category` | type (Lodge, Chalet, Stacaravan, Glamping, Villa, …), afgeleid uit de naam |

Tip: maak een productset met `custom_label_4` ≠ "niet beschikbaar", zodat je geen volgeboekte accommodaties adverteert.

## Adressen verbeteren

`data/locaties.csv` heeft één regel per park + plaats. De kolom `bron` geeft aan hoe nauwkeurig het adres is:

- `osm-park`: het park zelf gevonden (straat en postcode)
- `osm-plaats` / `osm-regio`: alleen het midden van de plaats of regio
- `niet-gevonden`: geen coördinaten, dus de accommodaties staan **niet** in de feed

Vul de juiste gegevens in en zet `bron` op `handmatig`; die regel wordt dan nooit overschreven. Bewerk het bestand liefst in een teksteditor. Excel kan de decimale punten van coördinaten omzetten.

## Veiligheid

- Mislukt het ophalen van de lijst, dan wordt de feed niet bijgewerkt.
- Bevat een nieuwe feed minder dan 70% van de items van de vorige run, dan wordt hij als `*.afgekeurd.xml` weggeschreven en blijft de oude staan. Zo verwijdert Meta niet ineens de halve catalogus.
- De feed wordt pas vervangen als hij helemaal klaar is, zodat Meta nooit een half bestand ophaalt.

## Bestanden

- `output/eezz-meta-hotel-feed.xml`: de feed
- `output/rapport.csv`: per accommodatie wat er is opgenomen, de prijs en de reden als iets ontbreekt
- `output/samenvatting.json`: totalen van de laatste run
- `data/`: tussengeheugen (details, prijzen, adressen). Mag je wissen; de volgende run duurt dan langer.
