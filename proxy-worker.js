// ============================================================
// Cloudflare Worker - Proxy OpenRouteService
// ============================================================
// Ce worker cache la clé API ORS côté serveur.
//
// Déploiement :
// 1. Créer un compte sur https://workers.cloudflare.com
// 2. Créer un Worker "ors-proxy" et copier ce script
// 3. Dans Settings → Variables, ajouter :
//    Clé : ORS_API_KEY
//    Valeur : votre clé openrouteservice.org
// 4. Cliquer sur Deploy
// 5. Noter l'URL du worker (ex: https://ors-proxy.votre-compte.workers.dev)
//
// Usage depuis app.js :
//   POST {lat1, lon1, lat2, lon2}
//   Retourne le GeoJSON de l'itinéraire hiking
// ============================================================

const ORS_URL = 'https://api.openrouteservice.org/v2/directions/foot-hiking/geojson';

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    if (request.method !== 'POST') {
      return errorResponse(405, 'Method Not Allowed');
    }

    // Supporte à la fois le mode Module (env.ORS_API_KEY) et l'ancien mode
    // Service Worker (variable globale ORS_API_KEY injectée par Cloudflare)
    const apiKey = env?.ORS_API_KEY
                 ?? (typeof ORS_API_KEY !== 'undefined' ? ORS_API_KEY : null)
                 ?? (typeof self !== 'undefined' && self.ORS_API_KEY ? self.ORS_API_KEY : null);

    if (!apiKey) {
      return errorResponse(500, 'ORS_API_KEY non configurée dans le Worker');
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return errorResponse(400, 'JSON invalide');
    }

    const { lat1, lon1, lat2, lon2 } = body;
    if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) {
      return errorResponse(400, 'Paramètres requis : lat1, lon1, lat2, lon2');
    }

    try {
      const orsRes = await fetch(ORS_URL, {
        method: 'POST',
        headers: {
          'Authorization': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          coordinates: [[lon1, lat1], [lon2, lat2]],
          elevation: true,
        }),
      });

      if (!orsRes.ok) {
        const text = await orsRes.text();
        return errorResponse(orsRes.status, text);
      }

      const data = await orsRes.json();

      return new Response(JSON.stringify(data), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch (err) {
      return errorResponse(500, err.message);
    }
  },
};

function errorResponse(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
