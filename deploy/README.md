# Déploiement du serveur CONNECT

Un seul serveur Linux suffit (1 vCPU et 1 Go de RAM largement, le serveur ne voit jamais l'écran). Il héberge :

* **connect** : le serveur de signalisation (Node.js) ;
* **caddy** : le HTTPS/WSS, avec certificat Let's Encrypt automatique ;
* **coturn** : le relais TURN, pour les connexions qui ne passent pas en direct.

## Avant de commencer

1. Un serveur Linux avec une adresse IPv4 publique (VPS chez OVH, Scaleway, Hetzner, etc.) et **Docker avec le plugin Compose** (`docker compose version`).
2. Un **nom de domaine** (par exemple `connect.remithollet.fr`) : enregistrement DNS de type **A** vers l'IP du serveur. Pas de proxy CDN (Cloudflare en « nuage orange » casserait TURN) : DNS seul.
3. Ouvrir ces ports dans le pare-feu du serveur (et du fournisseur) :

| Port | Protocole | Usage |
|---|---|---|
| 80, 443 | TCP | HTTPS / WSS (Caddy) |
| 3478 | TCP et UDP | TURN |
| 49160 à 49200 | UDP | flux relayés par TURN |

## Installation

```bash
git clone https://github.com/agence-rt/agoa-connect.git && cd agoa-connect/deploy
cp .env.example .env
nano .env                       # DOMAIN, PUBLIC_IP, puis les deux secrets ci-dessous
openssl rand -base64 32         # à coller dans AGENCY_KEY
openssl rand -base64 24         # à coller dans TURN_PASSWORD
docker compose up -d --build
```

## Vérifier

```bash
docker compose ps                                  # les trois services « running » (connect « healthy »)
curl https://VOTRE_DOMAINE/health                  # {"ok":true,"online":0}
docker compose logs connect | head                 # pas d'avertissement AGENCY_KEY
```

Puis, sur un poste CONNECT : **Réglages** → adresse `wss://VOTRE_DOMAINE`, clé de l'agence = la valeur de `AGENCY_KEY`. Le voyant passe à « En ligne ».

Test du relais TURN (facultatif) : sur https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/ , ajouter `turn:VOTRE_DOMAINE:3478` avec `TURN_USER` / `TURN_PASSWORD` : une ligne de type `relay` doit apparaître.

## Distribuer la clé aux postes

La clé de l'agence est un secret commun. Transmettez-la par un canal privé (gestionnaire de mots de passe, de vive voix), jamais par le dépôt. Chaque poste la saisit une fois au premier lancement.

## Mise à jour

```bash
cd agoa-connect && git pull && cd deploy && docker compose up -d --build
```

Les postes connectés sont déconnectés quelques secondes et se reconnectent seuls.

## Changer la clé ou le mot de passe TURN

Modifier `.env`, puis `docker compose up -d`. Si la clé change, chaque poste doit saisir la nouvelle dans ses Réglages.

## Sauvegarde

Rien à sauvegarder côté serveur : il ne stocke aucune donnée. Seuls `.env` et le volume `caddy_data` (certificats, régénérables) existent.
