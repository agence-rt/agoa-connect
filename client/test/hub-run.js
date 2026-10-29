'use strict';
// Lance un hub de poste (mode réseau privé) pour le test de bout en bout : node hub-run.js PORT CLE
const { createHub } = require('../../server/hub');
const hub = createHub({ key: process.argv[3] || '', ice: [], exposeWho: true, label: 'CONNECT : poste (test)' });
hub.listen(Number(process.argv[2]), '127.0.0.1').then(() => console.log('prêt'));
