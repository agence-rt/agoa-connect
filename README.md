# CONNECT

Présenter son écran ou prendre le contrôle d'un autre poste de l'agence, **par Internet**, entre ordinateurs où CONNECT est installé.

## Principe

```
 Poste « Anna » ──┐                                     ┌── Poste « Éléonore »
                  │  1. prénom + code, demande, accord  │
                  ├────────────►  Serveur  ◄────────────┤   signalisation seule :
                  │              (wss://…)              │   il ne voit jamais l'écran
                  │                                     │
                  └── 2. image de l'écran + commandes (WebRTC, chiffré) ──┘
                         en direct, ou via un relais TURN si le réseau bloque
```

* **Identifiant = prénom du poste.** Il est demandé une fois, au premier lancement. Il est unique parmi les postes en ligne (casse et accents ignorés). Deux postes d'une même personne se distinguent par un repère : « Dieu-Paris », « Dieu-Loire ».
* **Joindre un poste :** saisir son prénom (ou le choisir dans « Postes en ligne ») et le **code** que son utilisateur transmet. Le code est à six signes, **généré automatiquement à chaque lancement** de CONNECT et **détruit dès qu'il a servi** (un nouveau est alors généré).
* **Deux modes :** *Présenter* (je partage mon écran) et *Prendre le contrôle* (je pilote l'écran de l'autre). Le poste partagé accorde ou retire le contrôle à tout moment ; le poste qui regarde peut le demander.
* **Pas d'identité individuelle :** le launcher est connecté avec un compte Google commun, donc rien ne distingue les personnes. La sécurité repose sur trois choses : la **clé de l'agence** (secret commun, vérifié par le serveur), le **code à usage unique** transmis de vive voix, et l'**acceptation sur place** de chaque connexion.

## Contenu du dépôt

```
server/            serveur de signalisation (Node.js, un fichier) + Dockerfile + tests
client/            application de bureau (Electron)
  main.js          capture d'écran, injection souris/clavier, arrêt d'urgence
  preload.js       pont sécurisé vers l'interface
  renderer/        interface et logique WebRTC
  test/e2e.py      test de bout en bout (Chromium)
.github/workflows/ci.yml        tests à chaque envoi
.github/workflows/release.yml   installateur Windows publié à chaque étiquette de version
```

## Mise en route

### 1. Le serveur (une fois, sur une machine accessible depuis Internet)

Adresse en `wss://` obligatoire (TLS). Exemple avec Docker et Caddy :

```bash
docker build -t connect-serveur server
docker run -d --restart unless-stopped -p 127.0.0.1:8080:8080 \
  -e TRUST_PROXY=1 \
  -e AGENCY_KEY='une longue phrase secrète, la même sur tous les postes' \
  connect-serveur
```

```
# Caddyfile
connect.exemple.fr {
  reverse_proxy localhost:8080
}
```

| Variable | Rôle |
|---|---|
| `AGENCY_KEY` | Clé de l'agence. **À définir** : sans elle, n'importe quel client peut se connecter et lire la liste des prénoms. |
| `ICE_SERVERS` | Serveurs STUN/TURN envoyés aux postes (JSON). Voir « Relais TURN ». |
| `TRUST_PROXY` | `1` derrière un proxy, pour limiter les essais par vraie adresse. |
| `PORT` | Port d'écoute (8080 par défaut). |

### 2. Chaque poste

1. Installer CONNECT (installateur publié dans les *Releases* du dépôt, ou `cd client && npm install && npm start` pour essayer).
2. Au premier lancement, CONNECT demande le **prénom** du poste et, si elle n'est pas déjà fournie, la **clé de l'agence**.
3. Dans **Réglages**, vérifier l'adresse du serveur (`wss://connect.exemple.fr`).

Ces valeurs peuvent être fournies d'avance par le programme qui lance CONNECT, avec les variables d'environnement `CONNECT_SERVER`, `CONNECT_KEY` et `CONNECT_PRENOM`. Un poste doit avoir CONNECT ouvert pour être joignable.

### 3. Publier une version

```bash
git tag v0.1.0 && git push origin v0.1.0
```

Le workflow `release.yml` construit l'installateur Windows et l'ajoute à la release GitHub.

### Relais TURN

Sans relais, une connexion directe échoue derrière certains réseaux (entreprise, 4G). Installer `coturn` sur un serveur public, puis :

```bash
ICE_SERVERS='[{"urls":["stun:turn.exemple.fr:3478","turn:turn.exemple.fr:3478"],"username":"connect","credential":"UN_MOT_DE_PASSE_LONG"}]'
```

La barre de session affiche « direct » ou « relais » à côté du temps de réponse.

## Secrets : à ne jamais committer

`AGENCY_KEY` et les identifiants TURN se définissent sur le serveur (variables d'environnement), jamais dans le code ni dans ce dépôt. Un dépôt **privé** est recommandé. Chaque poste enregistre sa clé dans son dossier de configuration local.

## Sécurité en place

* Image et commandes chiffrées de bout en bout (DTLS-SRTP de WebRTC) : le serveur n'y a pas accès.
* Clé de l'agence vérifiée en temps constant ; code à usage unique ; 5 essais ratés par minute et par adresse.
* **Consentement à chaque connexion** : le poste appelé voit qui demande quoi. Le contrôle est une case distincte, décochée par défaut.
* Le poste partagé **revérifie** l'autorisation à chaque commande reçue.
* **Arrêt d'urgence** : `Ctrl + Alt + X` (`⌘ + Alt + X` sur Mac), même quand l'autre poste tient la souris.
* Touches et boutons enfoncés à distance relâchés en fin de contrôle.

## Limites connues

* Pas de postes de confiance (accès sans surveillance) : chaque connexion demande le code et l'acceptation.
* Le prénom n'est pas une preuve d'identité : toute personne qui connaît la clé de l'agence peut prendre n'importe quel prénom libre.
* Pas de réduction dans la zone de notification ni de démarrage avec Windows : CONNECT doit être ouvert.
* Écran principal uniquement ; ni presse-papiers partagé, ni fichiers, ni audio.
* Windows : une fenêtre lancée en administrateur (ou l'invite UAC) ne se laisse pas piloter par une application normale.
* Mac : autoriser l'application dans Réglages Système > Confidentialité (*Enregistrement de l'écran* et *Accessibilité*).
* L'installateur n'est pas signé : SmartScreen affichera un avertissement.
* Pas encore d'icône : celle d'Electron s'affiche (voir `client/package.json`, clé `build.win.icon`).

## Tests

```bash
cd server && npm ci && npm test        # protocole du serveur (18 contrôles)
python3 client/test/e2e.py             # fenêtres Chromium, vraie connexion WebRTC (34 contrôles)
```

Le test de bout en bout remplace la couche Electron (capture, injection) par des simulations. Il valide donc l'identification, la vidéo, le canal de commandes et les autorisations, mais **pas** `client/main.js` ni l'injection réelle par `nut-js` : ces deux points se vérifient sur un vrai poste. Les workflows GitHub n'ont pas encore tourné.
