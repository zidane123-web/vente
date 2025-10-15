# Business Hub Dashboard Plan

## Vision
- Transformer l ancienne page Tresorerie en un centre de pilotage complet couvrant tresorerie, ventes, stock, depenses, marge et operations.
- Offrir une vue synthetique, visuelle et actionnable: le dirigeant obtient l etat de sante du business en 30 s, puis explore les details module par module.
- Rester utilisable sur tablette/PC/telephone avec le meme esprit POS, tout en ajoutant une profondeur analytics (graphiques, tendances, alertes).

## Indicateurs clefs
- **Tresorerie**: solde global, solde par compte, flux entrants/sortants 7j, prevision cash 7j.
- **Ventes**: chiffre d affaires HT/TTC, marge brute, top 5 familles et top 5 produits, taux de conversion (ventes vs devis).
- **Stock**: valeur stock, jours de couverture, ruptures critiques, slow movers, mouvements recents (entrées/sorties/retours).
- **Depenses**: depenses fonctionnelles du mois, ecart vs budget, depenses en attente de validation, depenses exceptionnelles.
- **Fournisseurs/Commandes**: dettes fournisseurs, commandes en retard, acomptes a regulariser, remboursements a emettre.
- **Clients/Recouvrement**: creances clients, echeances depassees, avances a consommer, top clients.
- **Operations**: alertes caisse (non fermee, ecarts), incidents SAV, tickets support, statut offline/sync.

## Experience utilisateur
- **Header fixe**: nom site, date, badge sync, switch multi-sites, bouton utilisateur.
- **Actions rapides**: boutons action (nouvelle vente, enregistrer paiement fournisseur, enregistrer depense, transferer fonds, ajouter reception stock, exporter rapport) avec indicateurs si action bloque.
- **Widgets synthese** (grille 2 colonnes desktop, 1 mobile):
  - Carte Tresorerie avec gauge et sparkline flux.
  - Carte Ventes & Marge avec graphique barres (jour, semaine, mois) + chips segment.
  - Carte Stock avec indicateurs couverture (heatmap) et liste ruptures.
  - Carte Depenses avec donut categories + liste a valider.
  - Carte Alertes critiques priorisees (rouge/orange) clic => action directe.
  - Carte Clients & Recouvrement avec progression paiements (anneaux).
- **Section Insights**: onglets `Tresorerie`, `Ventes`, `Stock`, `Depenses`, `Fournisseurs`, `Operations`.
  - Chaque onglet affiche tableau resume + mini graph (area, histogramme, bullet chart).
  - CTA `Ouvrir module` + filtres rapides (periode, site, equipe).
- **Focus Stories**: bandeau narratif auto (ex: "Stock critique: 4 produits < 2 jours de couverture") pour storytelling de la data.
- **Responsiveness**: accordions sur mobile, reflow cartes, graphs remplacés par indicateurs compacts si ecran < 400px.
- **Accessibilite**: contraste 4.5+, support clavier, textes alternatifs, descriptions pour graphs.

## Contenu visuel
- Palette base UI POS (bleu, vert, orange) avec niveaux d alerte (rouge, orange, jaune).
- Graphiques:
  - Sparkline pour flux cash.
  - Bar chart empile pour ventes (CA vs marge).
  - Heatmap stock (axe categorie vs jours couverture).
  - Donut depenses.
  - Bullet recouvrement vs objectif.
  - Timeline transactions critiques.
- Tableaux cards: colonnes triables, tags status, avatar/fournisseur, icones lucide coherents.

## Logique front
- Hook principal `useBusinessHubSnapshot(siteId, periode)`:
  - Recupere `cash_positions`, `sales_kpi`, `stock_metrics`, `expenses_metrics`, `fournisseurs_balances`, `clients_balances`.
  - Consolide alertes par priorite (tresorerie <2 jours couverture, facture fournisseur due >7j, rupture stock).
  - Gere fallback offline via IndexedDB (cache des 30 derniers jours) + flags `isStale`.
- Hooks secondaires par onglet, lazy load a l ouverture pour limiter charge.
- Gestion exceptions: wrapper `BusinessHubErrorBoundary` avec message + bouton recharger.
- State global (ex: store Zustand) pour periode, site courant, filtres.
- Memoisation heavy compute (stats marge) via web worker ou `requestIdleCallback`.

## Donnees backend
- Cloud Functions / cron:
  - `aggregateCashPosition` -> `cash_positions_daily`.
  - `aggregateSalesMargin` -> `sales_kpi_daily`.
  - `aggregateInventoryHealth` -> `stock_metrics_daily` (valeur, couverture, ruptures).
  - `aggregateExpenses` -> `expenses_summary_daily`.
  - `aggregateReceivablesPayables` -> `balance_clients_fournisseurs`.
- Triggers temps reel sur `mouvements_tresorerie`, `ventes`, `receptions_stock`, `depenses`, `paiements_fournisseurs` pour mettre a jour caches `current_state` (documents summary).
- Archivage BigQuery mensuel pour historique long terme et comparatif multi-sites.
- Permissions: role-based (agent limite, superviseur, admin). Certaines cartes masquées si droits insuffisants.

## Workflow utilisateur cible
1. Connecter -> header montre status sync et site courant.
2. Premier balayage cartes: solde cash, ventes jour, alertes ruptures; badges montrent anomalies.
3. Cliquer sur alerte (ex fournisseur) -> modal detail -> action `Payer` ou `Planifier`.
4. Passer onglet Stock -> voir mouvements recent, actions (commande, transfert).
5. Exporter rapport synthese (PDF ou XLS) depuis barre actions (selection periode + modules).

## Monitoring / mesures succes
- Taux adoption: nombre connexions quotidiennes, temps sur hub.
- Reponse alertes: temps moyen resolution dettes, ruptures, depenses.
- Precision data: ecart caisse physique vs systeme, delta stock (integrite).
- Performance: temps chargement initial < 2s, poids JS additionnel controle (<150kb).
- Sentry pour erreurs UI, log instrumentation sur interactions majeures.

## Livrables de conception
- Carte Figma responsive (desktop, tablet, mobile).
- Design system mis a jour (typographie, icones, couleurs alertes).
- Definition champs pour chaque widget, dictionnaire de donnees.
- Scenarios tests UX (par role) + scripts verification data vs Firestore.

