Plan : Nouvelle Gestion des Fournisseurs
=======================================

Objectif global
---------------
Mettre en place une gestion centralisée des dettes fournisseurs avec :
- un écran « Dettes Fournisseurs » accessible depuis la barre de navigation (admins uniquement) ;
- une vue synthétique listant les montants dus/avances par fournisseur ;
- une page de détail par fournisseur, regroupant historique des commandes/réceptions/paiements et actions (encaissement, annulation, export). 

Portée & étapes
---------------
1. Navigation & contrôle d’accès
   - Ajouter une entrée « Dettes fournisseurs » dans le menu principal et la bottom-nav, conditionnée au rôle patron/admin.
   - Empêcher l’accès via hash pour les rôles employés.

2. Vue liste « Dettes Fournisseurs »
   - Tableau ou cartes montrant, pour chaque fournisseur :
     * total commandé ; total reçu ; total payé ; avance nette (ce que le fournisseur nous doit) ; solde dû (ce que nous lui devons).
   - Options de filtrage (recherche texte, filtres statut/debt > 0, etc.).
   - Accès direct à la fiche détaillée + actions rapides (payer, relancer, exporter). 

3. Détail fournisseur enrichi
   - Réutiliser/étendre `screen-fournisseur-balance` :
     * onglets pour commandes, réceptions, paiements, notes ;
     * récap des mouvements financiers (acomptes, remboursements, paiements apures) ;
     * boutons « Enregistrer paiement », « Générer reçu / export PDF », « Annuler commande » (selon statut).
   - Historique consolidé : timeline commandes/réceptions/paiements/annulations.

4. Actions financières & mises à jour
   - Flux « Enregistrer paiement fournisseur » : sélection du compte, montant, affectation automatique aux dettes les plus anciennes, mise à jour `netSupplierBalance`.
   - Support des remboursements (fournisseur nous doit) : enregistrer l’encaissement et réinitialiser les avances.
   - Logger chaque opération dans la trésorerie et la sous-collection correspondante.

5. UX & feedbacks
   - États vides, loaders, messages d’erreur clair.
   - Confirmer les actions sensibles (annulation commande, remboursement, paiement).
   - Sauvegarder les références nécessaires pour l’audit (timestamps, utilisateur, justificatif).

Pré-requis et données
----------------------
- `approvisionnement` doit maintenir `receivedTotalCost`, `paymentsTotalPaid`, `netSupplierBalance`.
- Tenir compte des paiements enregistrés dans la sous-collection `payments` (statut, origine, remboursements).
- Garantir que les annulations de commandes/restaurations de paiements mettent à jour ces totaux.

Livrables attendus
------------------
- Nouveaux écrans `screen-dettes-fournisseurs` et enrichissement de `screen-fournisseur-balance`.
- Logique Firestore pour agréger dettes/avances et orchestrer les paiements fournisseurs.
- Contrôles UI + navigation adaptée selon le rôle.
