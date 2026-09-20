/* Where the registry front end reads its data from.
 *
 * Point this at the Registrar's public URL, with no trailing slash. Leave it
 * empty and the page renders a clearly-labelled sample register rather than
 * pretending to be live.
 *
 * NOTE: the Registrar currently runs on a free instance, which sleeps after a
 * spell with no inbound traffic. The first page load after a sleep waits for a
 * cold start — up to about a minute — and until it answers, the page falls
 * back to the sample register. A reload once it is awake shows live data.
 *
 * You can also aim the page at a different Registrar without redeploying,
 * which is the quickest way to check a new one before committing its URL:
 *
 *   https://incorporate-gules.vercel.app/?api=https://your-registrar.onrender.com
 */
window.INCORPORATE_API = "https://incorporate-registrar.onrender.com";
