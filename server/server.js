'use strict';
/*
 * CONNECT — serveur de signalisation (Internet).
 * Le protocole et la logique sont dans hub.js, partagé avec le mode « réseau privé » des postes.
 */
const { createHub } = require('./hub');

const PORT = Number(process.env.PORT) || 8080;
const AGENCY_KEY = process.env.AGENCY_KEY || '';   // clé commune des postes de l'agence (vide = ouvert, pour les essais)

let ICE = [{ urls: 'stun:stun.l.google.com:19302' }];
if (process.env.ICE_SERVERS) {
  try { ICE = JSON.parse(process.env.ICE_SERVERS); }
  catch { console.error('ICE_SERVERS : JSON invalide, valeur ignorée'); }
}
if (!AGENCY_KEY) console.warn('AGENCY_KEY non définie : tout client peut se connecter. À définir avant une mise en ligne.');

const hub = createHub({ key: AGENCY_KEY, ice: ICE, trustProxy: process.env.TRUST_PROXY === '1' });
hub.listen(PORT).then(() => console.log('Serveur de signalisation sur le port ' + PORT));
