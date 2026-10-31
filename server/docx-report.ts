import fs from 'node:fs/promises';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';

export interface StepObservation {
  index: number;
  api: string;
  label: string;
  status: string;
  durationSec: string;
  summary?: string;
  locationUrl?: string;
  errorMessage?: string;
}

export interface ScreenshotItem {
  id: string;
  label: string;
  relativePath: string;
  absolutePath: string;
  bytes: Uint8Array;
}

export interface WordReportInput {
  projectRoot: string;
  targetUrl: string;
  prompt: string;
  assertionPrompt?: string;
  highlightedSummary?: string;
  runStatus: string;
  startedAt: string;
  durationSec: string;
  finalUrl?: string;
  observations: StepObservation[];
  screenshots: ScreenshotItem[];
  videoPaths?: string[];
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function headingParagraph(text: string, level: 1 | 2 = 1): string {
  const fontSize = level === 1 ? '32' : '26';
  const color = level === 1 ? '1E293B' : '334155';
  return `<w:p>
    <w:pPr>
      <w:spacing w:before="240" w:after="120"/>
    </w:pPr>
    <w:r>
      <w:rPr>
        <w:b/>
        <w:color w:val="${color}"/>
        <w:sz w:val="${fontSize}"/>
      </w:rPr>
      <w:t>${escapeXml(text)}</w:t>
    </w:r>
  </w:p>`;
}

function keyValueParagraph(label: string, value: string, valueColor = '0F172A'): string {
  return `<w:p>
    <w:pPr><w:spacing w:before="60" w:after="60"/></w:pPr>
    <w:r>
      <w:rPr><w:b/><w:color w:val="475569"/><w:sz w:val="22"/></w:rPr>
      <w:t xml:space="preserve">${escapeXml(label)}: </w:t>
    </w:r>
    <w:r>
      <w:rPr><w:color w:val="${valueColor}"/><w:sz w:val="22"/></w:rPr>
      <w:t xml:space="preserve">${escapeXml(value)}</w:t>
    </w:r>
  </w:p>`;
}

function bodyParagraph(text: string, bold = false, color = '1E293B'): string {
  return `<w:p>
    <w:pPr><w:spacing w:before="60" w:after="80"/></w:pPr>
    <w:r>
      <w:rPr>
        ${bold ? '<w:b/>' : ''}
        <w:color w:val="${color}"/>
        <w:sz w:val="21"/>
      </w:rPr>
      <w:t xml:space="preserve">${escapeXml(text)}</w:t>
    </w:r>
  </w:p>`;
}

function imageDrawingParagraph(relId: string, docPrId: number, title: string): string {
  // 6 inches wide x 3.75 inches tall in EMUs (1 inch = 914400 EMUs)
  const cx = 5486400;
  const cy = 3429000;
  return `<w:p>
    <w:pPr>
      <w:jc w:val="center"/>
      <w:spacing w:before="120" w:after="200"/>
    </w:pPr>
    <w:r>
      <w:drawing>
        <wp:inline distT="0" distB="0" distL="0" distR="0"
          xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">
          <wp:extent cx="${cx}" cy="${cy}"/>
          <wp:docPr id="${docPrId}" name="${escapeXml(title)}"/>
          <wp:cNvGraphicFramePr>
            <a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/>
          </wp:cNvGraphicFramePr>
          <a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
            <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
              <pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
                <pic:nvPicPr>
                  <pic:cNvPr id="${docPrId}" name="${escapeXml(title)}"/>
                  <pic:cNvPicPr/>
                </pic:nvPicPr>
                <pic:blipFill>
                  <a:blip r:embed="${relId}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>
                  <a:stretch><a:fillRect/></a:stretch>
                </pic:blipFill>
                <pic:spPr>
                  <a:xfrm>
                    <a:off x="0" y="0"/>
                    <a:ext cx="${cx}" cy="${cy}"/>
                  </a:xfrm>
                  <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
                </pic:spPr>
              </pic:pic>
            </a:graphicData>
          </a:graphic>
        </wp:inline>
      </w:drawing>
    </w:r>
  </w:p>`;
}

/**
 * Generates a standalone Microsoft Word (.docx) file containing test metadata,
 * step-by-step AI observations, highlighted verification details, and embedded PNG screenshots.
 */
export async function generateWordObservationReport(
  input: WordReportInput
): Promise<{ latestDocxPath: string; timestampedDocxPath: string }> {
  const reportsDir = path.join(input.projectRoot, 'reports');
  await fs.mkdir(reportsDir, { recursive: true });

  const zipEntries: Record<string, Uint8Array> = {};
  const imageRels: string[] = [];

  input.screenshots.forEach((shot, idx) => {
    const mediaName = `image${idx + 1}.png`;
    const relId = `rIdImg${idx + 1}`;
    zipEntries[`word/media/${mediaName}`] = shot.bytes;
    imageRels.push(
      `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${mediaName}"/>`
    );
  });

  const statusColor =
    input.runStatus.toLowerCase() === 'passed' ? '059669' : 'DC2626';

  const bodyParts: string[] = [
    headingParagraph('QA Drive — Automated Test & Observation Report', 1),
    keyValueParagraph('Execution Status', input.runStatus.toUpperCase(), statusColor),
    keyValueParagraph('Target Application URL', input.targetUrl),
    keyValueParagraph('Final Page URL Observed', input.finalUrl ?? input.targetUrl),
    keyValueParagraph('Executed At', input.startedAt),
    keyValueParagraph('Total Duration', `${input.durationSec}s`),
    ...(input.videoPaths && input.videoPaths.length > 0
      ? [keyValueParagraph('Recorded Video File', input.videoPaths.join(', '), '1D4ED8')]
      : []),
    headingParagraph('1. Test Prompt & Verification Goal', 2),
  ];

  for (const line of input.prompt.split('\n')) {
    if (line.trim()) {
      bodyParts.push(bodyParagraph(`• ${line.trim()}`));
    }
  }

  if (input.assertionPrompt?.trim()) {
    bodyParts.push(
      keyValueParagraph('Expected Verification (Assertion)', input.assertionPrompt.trim(), '1D4ED8')
    );
  }

  if (input.highlightedSummary?.trim()) {
    bodyParts.push(
      headingParagraph('2. Highlighted Verification Observation on Page', 2),
      bodyParagraph(input.highlightedSummary.trim(), true, '0F766E')
    );
  }

  bodyParts.push(headingParagraph('3. Step-by-Step Execution & AI Observations', 2));

  if (input.observations.length === 0) {
    bodyParts.push(bodyParagraph('No step observations recorded.'));
  } else {
    for (const obs of input.observations) {
      const stepColor = obs.status === 'passed' ? '059669' : 'DC2626';
      bodyParts.push(
        bodyParagraph(
          `Step ${obs.index} [${obs.api}] (${obs.status.toUpperCase()} — ${obs.durationSec}s): ${obs.label}`,
          true,
          stepColor
        )
      );
      if (obs.summary) {
        bodyParts.push(bodyParagraph(`   Observation: ${obs.summary}`, false, '1E293B'));
      }
      if (obs.locationUrl) {
        bodyParts.push(bodyParagraph(`   Page URL: ${obs.locationUrl}`, false, '475569'));
      }
      if (obs.errorMessage) {
        bodyParts.push(bodyParagraph(`   Error: ${obs.errorMessage}`, false, 'DC2626'));
      }
    }
  }

  bodyParts.push(headingParagraph('4. Visual Evidence & Highlighted Screenshots', 2));

  if (input.screenshots.length === 0) {
    bodyParts.push(bodyParagraph('No screenshots were captured during this run.'));
  } else {
    input.screenshots.forEach((shot, idx) => {
      const relId = `rIdImg${idx + 1}`;
      bodyParts.push(
        bodyParagraph(`Figure ${idx + 1}: ${shot.label}`, true, '1E293B'),
        imageDrawingParagraph(relId, idx + 1, shot.label)
      );
    });
  }

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document
  xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    ${bodyParts.join('\n')}
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080"/>
    </w:sectPr>
  </w:body>
</w:document>`;

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

  const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  const docRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${imageRels.join('\n  ')}
</Relationships>`;

  zipEntries['[Content_Types].xml'] = strToU8(contentTypesXml);
  zipEntries['_rels/.rels'] = strToU8(rootRelsXml);
  zipEntries['word/document.xml'] = strToU8(documentXml);
  zipEntries['word/_rels/document.xml.rels'] = strToU8(docRelsXml);

  const docxBuffer = zipSync(zipEntries, { level: 6 });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let latestDocxPath = path.join(reportsDir, 'e2e-observation-report-latest.docx');
  const timestampedDocxPath = path.join(reportsDir, `e2e-observation-report-${stamp}.docx`);

  // Write the unique timestamped file first so a locked file open in Microsoft Word never blocks report generation
  await fs.writeFile(timestampedDocxPath, docxBuffer);
  try {
    await fs.writeFile(latestDocxPath, docxBuffer);
  } catch {
    // If e2e-observation-report-latest.docx is currently open/locked in Word, use the timestamped file path
    latestDocxPath = timestampedDocxPath;
  }

  return { latestDocxPath, timestampedDocxPath };
}
