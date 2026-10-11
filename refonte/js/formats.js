/*
 * Formats produits par Declinator.
 *
 * Pour ajouter un format : copier une ligne, puis changer
 *   - id     : identifiant unique, en minuscules, sans espace ni accent (il sert dans le nom des fichiers)
 *   - name   : le nom affiché dans l'app
 *   - width  : largeur en pixels
 *   - height : hauteur en pixels
 * Pour créer une nouvelle rubrique, copier un bloc { name: ..., formats: [...] }.
 */
window.DECLINATOR_FORMATS = [
  {
    name: 'Site 6MIC',
    formats: [
      { id: 'carrousel-accueil', name: "Carrousel page d'accueil", width: 280, height: 400 },
      { id: 'cover-evenement', name: 'Cover page événement', width: 600, height: 420 },
      { id: 'visuel-artiste', name: 'Visuel artiste', width: 500, height: 500 }
    ]
  },
  {
    name: 'Billetteries',
    formats: [
      { id: 'billetterie-6mic', name: 'Billetterie 6MIC', width: 1000, height: 1000 },
      { id: 'seeticket', name: 'Seeticket', width: 300, height: 300 },
      { id: 'fnac', name: 'Fnac', width: 1000, height: 1000 },
      { id: 'ticketmaster', name: 'Ticketmaster', width: 1200, height: 1900 },
      { id: 'shotgun-1', name: 'Shotgun 1', width: 1920, height: 1080 },
      { id: 'shotgun-2', name: 'Shotgun 2', width: 1080, height: 1440 }
    ]
  }
];
