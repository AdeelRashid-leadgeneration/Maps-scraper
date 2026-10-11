# Lead Tools
1. `leadfinder.html` — search Google Maps leads (Serper key), export CSV.
2. `enrich.py` — reads that CSV and adds owner name, sales/general/personal emails, company + direct phones, social links.

    pip install -r requirements.txt
    python enrich.py leads_Realtors.csv

Output: `leads_Realtors_enriched.csv`. Only publicly listed info from each company's own site; robots.txt respected.
