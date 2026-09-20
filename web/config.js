/* Where the registry front end reads its data from.
 *
 * Set this to the Registrar's public URL, with no trailing slash, then
 * redeploy. Leave it empty and the page renders a clearly-labelled sample
 * register instead of pretending to be live.
 *
 *   window.INCORPORATE_API = "https://incorporate-registrar.onrender.com";
 *
 * You can also point the page at a Registrar without redeploying, which is the
 * quickest way to confirm a new one is reachable before committing its URL:
 *
 *   https://incorporate-gules.vercel.app/?api=https://your-registrar.onrender.com
 */
window.INCORPORATE_API = "";
