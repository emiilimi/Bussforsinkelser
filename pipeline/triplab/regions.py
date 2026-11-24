"""Byområdene reiselaboratoriet trekker reiser i.

bbox = (sør, vest, nord, øst) i WGS84. `destinations` er reisemål folk
faktisk reiser til, som (søketekst for Entur-geokoderen, type). Geokoderen
gir holdeplassen med det navnet; reisen går dit. Typene styrer når på døgnet
reisen skjer (se sample_od.py). `operator` er prefikset i line_ref.

Hvorfor en håndlaget liste: Overpass (OpenStreetMap) var nede 2026-11-23
(utløpt sertifikat på hovedserveren, speilene svarte ikke), og Enturs
geokoder har ikke kategorisøk. Lista er også mer treffsikker: «store
arbeidsplasser» finnes ikke som én OSM-kategori.
"""

REGIONS = {
    "bergen": {
        "bbox": (60.25, 5.15, 60.52, 5.50),
        "operator": "SKY",
        "destinations": [
            ("Byparken", "sentrum"),
            ("Bergen busstasjon", "sentrum"),
            ("Haukeland sykehus", "sykehus"),
            ("Haukeland sjukehus sør", "sykehus"),
            ("Møllendalsplass", "studiested"),
            ("Studentsenteret", "studiested"),
            ("Kronstad", "studiested"),
            ("Handelshøyskolen", "studiested"),
            ("Kokstad", "arbeid"),
            ("Sandsli", "arbeid"),
            ("Marineholmen", "arbeid"),
            ("Bontelabo", "arbeid"),
            ("Lagunen", "kjøpesenter"),
            ("Åsane senter", "kjøpesenter"),
            ("Oasen", "kjøpesenter"),
            ("Nesttun terminal", "knutepunkt"),
            ("Flesland", "flyplass"),
        ],
    },
    "oslo": {
        "bbox": (59.82, 10.55, 60.02, 11.05),
        "operator": "RUT",
        "destinations": [
            ("Jernbanetorget", "sentrum"),
            ("Nationaltheatret", "sentrum"),
            ("Rikshospitalet", "sykehus"),
            ("Ullevål sykehus", "sykehus"),
            ("Ahus", "sykehus"),
            ("Blindern", "studiested"),
            ("Pilestredet", "studiested"),
            ("Nydalen", "studiested"),
            ("Fornebu", "arbeid"),
            ("Lysaker", "arbeid"),
            ("Skøyen", "arbeid"),
            ("Helsfyr", "arbeid"),
            ("Bjørvika", "arbeid"),
            ("Storo", "kjøpesenter"),
            ("Storo", "arbeid"),
            ("Linderud T", "kjøpesenter"),
            ("Lambertseter senter", "kjøpesenter"),
        ],
    },
    "trondheim": {
        "bbox": (63.35, 10.25, 63.47, 10.55),
        "operator": "ATB",
        "destinations": [
            ("Prinsens gate", "sentrum"),
            ("St. Olavs hospital", "sykehus"),
            ("Gløshaugen", "studiested"),
            ("Dragvoll", "studiested"),
            ("Sluppen", "arbeid"),
            ("Tiller", "arbeid"),
            ("Brattøra", "arbeid"),
            ("City Syd", "kjøpesenter"),
            ("Moholt", "knutepunkt"),
        ],
    },
    "stavanger": {
        "bbox": (58.82, 5.55, 59.00, 5.80),
        "operator": "KOL",
        "destinations": [
            ("Stavanger byterminal", "sentrum"),
            ("SUS Ullandhaug", "sykehus"),
            ("Ullandhaugveien", "studiested"),
            ("Forus", "arbeid"),
            ("Hinna sentrum", "arbeid"),
            ("Kvadrat", "kjøpesenter"),
            ("Sandnes sentrum", "sentrum"),
        ],
    },
    "kristiansand": {
        "bbox": (58.10, 7.90, 58.20, 8.15),
        "operator": "AKT",
        "destinations": [
            ("Henrik Wergelands gate", "sentrum"),
            ("Sykehuset", "sykehus"),
            ("Universitetet", "studiested"),
            ("Sørlandssenteret terminal", "kjøpesenter"),
            ("Sørlandssenteret terminal", "arbeid"),
        ],
    },
}
