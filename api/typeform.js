export default async function handler(req, res) {
  const { formId, ...rest } = req.query;

  if (!formId) {
    return res.status(400).json({ error: "formId is required" });
  }

  const params = new URLSearchParams(rest).toString();
  const url = `https://api.typeform.com/forms/${formId}/responses${params ? `?${params}` : ""}`;

  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.TYPEFORM_TOKEN}` },
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch from Typeform" });
  }
}
