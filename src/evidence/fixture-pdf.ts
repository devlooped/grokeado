import { deflateSync } from "node:zlib";

export type FixturePage = { text?: string; flate?: boolean; image?: Uint8Array };

function escapePdfText(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

export function buildFixturePdf(pages: readonly FixturePage[]): Uint8Array {
  const parts: Buffer[] = [];
  const offsets = [0];
  let cursor = 0;
  const push = (value: Buffer | string) => {
    const buffer = typeof value === "string" ? Buffer.from(value, "latin1") : value;
    parts.push(buffer);
    cursor += buffer.byteLength;
  };
  const add = (id: number, body: string, stream?: Buffer) => {
    offsets[id] = cursor;
    if (stream) push(`${id} 0 obj\n${body}\nstream\n`);
    else push(`${id} 0 obj\n${body}\nendobj\n`);
    if (stream) {
      push(stream);
      push("\nendstream\nendobj\n");
    }
  };

  push("%PDF-1.4\n");
  let nextId = 4;
  const pageIds: number[] = [];
  const objects: Array<{ id: number; body: string; stream?: Buffer }> = [];
  for (const page of pages) {
    const pageId = nextId++;
    const contentId = nextId++;
    pageIds.push(pageId);
    let resources = "/Font << /F1 3 0 R >>";
    let operators = `BT /F1 12 Tf 72 720 Td (${escapePdfText(page.text ?? "")}) Tj ET`;
    if (page.image) {
      const imageId = nextId++;
      resources = `/XObject << /Im1 ${imageId} 0 R >>`;
      operators = "q 100 0 0 100 0 0 cm /Im1 Do Q";
      objects.push({
        id: imageId,
        body: `<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.image.byteLength} >>`,
        stream: Buffer.from(page.image),
      });
    }
    const plain = Buffer.from(operators, "latin1");
    const stream = page.flate ? deflateSync(plain) : plain;
    if (page.flate) {
      const lengthId = nextId++;
      objects.push({ id: lengthId, body: String(stream.byteLength) });
      objects.push({ id: contentId, body: `<< /Filter /FlateDecode /Length ${lengthId} 0 R >>`, stream });
    } else {
      objects.push({ id: contentId, body: `<< /Length ${stream.byteLength} >>`, stream });
    }
    objects.push({
      id: pageId,
      body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << ${resources} >> >>`,
    });
  }
  add(1, "<< /Type /Catalog /Pages 2 0 R >>");
  add(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`);
  add(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  for (const object of objects.sort((a, b) => a.id - b.id)) add(object.id, object.body, object.stream);

  const xrefAt = cursor;
  const size = offsets.length;
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let id = 1; id < size; id++) xref += `${String(offsets[id] ?? 0).padStart(10, "0")} 00000 n \n`;
  xref += `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  push(xref);
  return new Uint8Array(Buffer.concat(parts));
}
