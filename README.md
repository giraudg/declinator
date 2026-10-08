# Declinator

Outil du service com du 6MIC : on importe une photo, on clique sur le sujet (le point de focus), et l'app produit toutes les déclinaisons nécessaires pour le site et les billetteries, recadrées autour de ce point. Un clic télécharge le tout dans un .zip.

## Utilisation

1. Glisser une photo dans la fenêtre (ou « choisissez un fichier », ou coller une image copiée avec ⌘V / Ctrl+V).
2. Cliquer sur le sujet pour placer le point de focus. Survoler une vignette montre son cadre sur la photo.
3. Si besoin, cliquer sur une vignette pour ajuster son cadrage à la main (glisser le cadre, zoomer avec la molette ou le curseur, Échap pour terminer).
4. Pour un visuel qui ne doit pas être recadré (un bandeau avec du texte dans un format vertical, par exemple), activer « Conserver le ratio » sur la vignette, ou pour tous les formats d'un coup (voir plus bas).
5. Cliquer sur « Télécharger les 9 formats (.zip) ». On peut aussi télécharger un format seul, ou décocher les formats inutiles.

Les fichiers sont nommés `nom_format_LARGEURxHAUTEUR.jpg`, par exemple `concert-ete_billetterie-6mic_1000x1000.jpg`. Le nom de base est repris du fichier d'origine et se modifie en bas de l'écran.

### Règle de cadrage

Pour chaque format, l'app prend le plus grand cadre possible aux bonnes proportions, le centre sur le point de focus, puis le réduit à la taille finale. Si le point de focus est près d'un bord, le cadre s'arrête au bord de la photo : le sujet est alors placé au plus près du centre, sans zoom ni perte de qualité.

Quand la photo d'origine est plus petite que le format demandé, la vignette affiche une alerte (« agrandie ×2,5, risque de flou »).

### Conserver le ratio

Avec cette option, l'image n'est pas recadrée : elle est gardée en entier, centrée, et le vide autour est rempli. Trois fonds au choix, communs à tous les formats concernés :

- **Flou** : la bande de bord de l'image est prolongée dans le vide puis fortement floutée. Les couleurs se raccordent au bord de l'image sans dupliquer le sujet.
- **Couleur** : une couleur unie.
- **Dégradé** : le vide part des couleurs du bord de l'image (comme le flou) et glisse progressivement vers la couleur choisie. Le curseur « Longueur du dégradé » règle où la couleur pure est atteinte : à 60 %, elle l'est aux six dixièmes du vide ; à 100 %, seulement au bord du visuel.

Pour Couleur et Dégradé, l'app propose par défaut la couleur moyenne des bords de la photo. On peut la changer avec le sélecteur de couleur, ou avec la **pipette** : cliquer sur « Pipette », puis sur la photo (une loupe montre le pixel visé et son code couleur). Échap pour annuler.

L'option se règle format par format (interrupteur sous chaque vignette) ou pour tous les formats d'un coup (« Tous les formats : Recadrer / Conserver le ratio »). Le point de focus et le cadrage manuel ne s'appliquent qu'aux formats recadrés.

## Formats

| Rubrique | Format | Taille (px) |
|---|---|---|
| Site 6MIC | Carrousel page d'accueil | 280 × 400 |
| Site 6MIC | Cover page événement | 600 × 420 |
| Site 6MIC | Visuel artiste | 500 × 500 |
| Billetteries | Billetterie 6MIC | 1000 × 1000 |
| Billetteries | Seeticket | 300 × 300 |
| Billetteries | Fnac | 1000 × 1000 |
| Billetteries | Ticketmaster | 1200 × 1900 |
| Billetteries | Shotgun 1 | 1920 × 1080 |
| Billetteries | Shotgun 2 | 1080 × 1440 |

Pour ajouter, retirer ou modifier un format, éditer **`js/formats.js`** (les instructions sont en tête du fichier) puis remettre ce fichier en ligne. Rien d'autre à toucher.

## Mise en ligne

L'app est un site statique : pas de base de données, pas de PHP, pas de compilation. Le fichier `robots.txt` et la balise `noindex` empêchent les moteurs de recherche de l'indexer.

### Avec GitHub Pages (dépôt `giraudg/declinator`)

1. Envoyer **tout le contenu de ce dossier** à la racine du dépôt (y compris le fichier caché `.nojekyll`). Sans git : sur la page du dépôt, « Add file → Upload files », puis glisser les fichiers et dossiers.
2. Dans le dépôt : **Settings → Pages → Build and deployment**, Source « Deploy from a branch », branche `main`, dossier `/ (root)`, puis Save. Le site est en ligne au bout d'une minute environ, à l'adresse `https://giraudg.github.io/declinator/`.
3. Pour le sous-domaine (par exemple `declinaisons.6mic.fr`) :
   - chez le registrar du domaine, créer un enregistrement **CNAME** `declinaisons` → `giraudg.github.io` ;
   - dans Settings → Pages → Custom domain, saisir `declinaisons.6mic.fr`, Save, puis cocher **Enforce HTTPS** dès que GitHub le propose (le certificat peut prendre jusqu'à une heure).
4. Pour modifier les formats plus tard : éditer `js/formats.js` directement sur GitHub (icône crayon), Commit. Le site se met à jour tout seul.

À savoir : un site GitHub Pages est public (pas de mot de passe possible avec un compte gratuit). Ce n'est pas un problème pour cet outil : il ne contient aucune donnée, et les photos ne quittent jamais le navigateur.

### Chez un hébergeur classique

1. Créer le sous-domaine chez l'hébergeur, idéalement en HTTPS.
2. Copier tout le contenu de ce dossier à la racine du sous-domaine (FTP/SFTP ou gestionnaire de fichiers), en gardant les sous-dossiers `css`, `js`, `vendor` et `fonts`.
3. Pour limiter l'accès à l'équipe, on peut ajouter une protection par mot de passe (authentification HTTP / `.htaccess`).

Pour tester sans serveur : double-cliquer sur `index.html`, l'app fonctionne aussi en local.

## Confidentialité

Tout le traitement se fait dans le navigateur de la personne qui utilise l'outil. **Aucune photo n'est envoyée sur un serveur ni conservée** : fermer l'onglet efface tout. Les fichiers exportés ne contiennent pas les métadonnées de la photo d'origine (appareil, GPS…).

Seuls quelques réglages sont mémorisés dans le navigateur, pour le confort : JPG ou PNG, la qualité JPG, les formats décochés, le type de fond (flou, couleur ou dégradé) et la longueur du dégradé.

L'app ne fait aucun appel externe (pas de Google Fonts, pas de CDN, pas de statistiques).

## Détails techniques

- Navigateurs : Chrome, Edge, Firefox et Safari récents.
- Formats acceptés : JPG, PNG, WebP, HEIC/HEIF (photos iPhone, converties à la volée dans le navigateur), et ce que le navigateur sait lire (AVIF, GIF…). L'orientation des photos de téléphone est appliquée automatiquement.
- Qualité : découpe dans la photo d'origine en pleine résolution, puis réduction avec un filtre Lanczos (bibliothèque pica) et un léger renforcement de netteté. Export JPG (fond blanc si la photo a de la transparence) ou PNG. Couleurs en sRGB, adaptées au web.
- Les aperçus utilisent une copie allégée de la photo pour rester fluides ; les fichiers exportés sont calculés en haute qualité au moment du téléchargement.

### Structure

```
index.html        page de l'app
js/formats.js     liste des formats (à modifier ici)
js/app.js         logique : focus, cadrage, aperçus, export
css/app.css       mise en forme
vendor/           bibliothèques (JSZip, pica, heic2any)
fonts/            police Archivo
favicon.svg, robots.txt
.nojekyll         indique à GitHub Pages de servir les fichiers tels quels
```

### Bibliothèques

- [JSZip](https://stuk.github.io/jszip/) 3.10 : création du .zip (licence MIT ou GPLv3)
- [pica](https://github.com/nodeca/pica) 9.0 : redimensionnement haute qualité (MIT)
- [heic2any](https://github.com/alexcorvi/heic2any) 0.0.4 : lecture des photos HEIC (MIT)
- [Archivo](https://github.com/Omnibus-Type/Archivo) d'Omnibus-Type : police de l'interface (SIL Open Font License, voir `fonts/OFL-Archivo.txt`)
