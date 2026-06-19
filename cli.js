#!/usr/bin/env node

const { program } = require('commander');
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const ora = require('ora');
const sharp = require('sharp');

// ============================================================
// SVG GENERATOR - Fixed Text Scaling
// ============================================================
const text_scale = 1.0;
class DiagramSVGGenerator {
	constructor(width, height, diagramData, positions = null) {
		this.width = width;
		this.height = height;
		this.data = diagramData;
		this.positions = positions || null;
		this.statePositions = {};
		this._stateMap = {};
		this._defaults = {};
		this._layout = {};
		this._transitions = [];
		this._scale = 1;
		this._offsetX = 0;
		this._offsetY = 0;
		this._baseSize = 1000; // Base size for layout calculation

		// Calculate layout first (without scaling)
		this.calculateLayout();

		// Then fit to canvas
		this.fitToCanvas();
	}

	fitToCanvas() {
		// Calculate bounds of all elements
		let minX = Infinity,
			minY = Infinity,
			maxX = -Infinity,
			maxY = -Infinity;

		for (const [id, pos] of Object.entries(this.statePositions)) {
			minX = Math.min(minX, pos.x);
			minY = Math.min(minY, pos.y);
			maxX = Math.max(maxX, pos.x + pos.width);
			maxY = Math.max(maxY, pos.y + pos.height);
		}

		// Also check transition control points
		for (const t of this._transitions) {
			const fromPos = this.statePositions[t.from];
			const toPos = this.statePositions[t.to];
			if (!fromPos || !toPos) continue;

			const fromX = fromPos.centerX;
			const fromY = fromPos.centerY;
			const toX = toPos.centerX;
			const toY = toPos.centerY;

			const dx = toX - fromX;
			const dy = toY - fromY;
			const len = Math.sqrt(dx * dx + dy * dy);
			const nx = -dy / len;
			const ny = dx / len;
			const curveAmount = Math.min(60, len * 0.35);
			const cpX = (fromX + toX) / 2 + nx * curveAmount;
			const cpY = (fromY + toY) / 2 + ny * curveAmount;

			minX = Math.min(minX, cpX);
			minY = Math.min(minY, cpY);
			maxX = Math.max(maxX, cpX);
			maxY = Math.max(maxY, cpY);
		}

		// Add padding
		const padding = 80;
		minX -= padding;
		minY -= padding;
		maxX += padding;
		maxY += padding;

		const diagramWidth = maxX - minX;
		const diagramHeight = maxY - minY;

		// Calculate scale to fit the canvas (with some margin)
		const scaleX = this.width / diagramWidth;
		const scaleY = this.height / diagramHeight;
		this._scale = Math.min(scaleX, scaleY) * 0.9; // 90% to leave margin

		// Calculate offset to center the diagram
		this._offsetX = (this.width - diagramWidth * this._scale) / 2 - minX * this._scale;
		this._offsetY = (this.height - diagramHeight * this._scale) / 2 - minY * this._scale;

		// Apply scaling to all positions
		for (const [id, pos] of Object.entries(this.statePositions)) {
			pos.x = pos.x * this._scale + this._offsetX;
			pos.y = pos.y * this._scale + this._offsetY;
			pos.width = pos.width * this._scale;
			pos.height = pos.height * this._scale;
			pos.centerX = pos.x + pos.width / 2;
			pos.centerY = pos.y + pos.height / 2;
		}
	}

	calculateLayout() {
		if (!this.data) return;

		const states = this.data.states;
		const layout = this.data.layout || {};
		const padding = layout.padding || 80;

		// Use a base size for calculation
		const baseWidth = 1000;
		const baseHeight = 800;

		const defaultWidth = this.data.defaults?.state?.width || 160;
		const defaultHeight = this.data.defaults?.state?.height || 70;

		// Build graph
		const adj = {};
		const inDegree = {};
		const stateMap = {};
		states.forEach((s) => {
			adj[s.id] = [];
			inDegree[s.id] = 0;
			stateMap[s.id] = s;
		});

		const transitions = this.data.transitions || [];
		transitions.forEach((t) => {
			if (adj[t.from]) {
				adj[t.from].push(t.to);
				inDegree[t.to] = (inDegree[t.to] || 0) + 1;
			}
		});

		// Find roots
		const roots = states.filter((s) => inDegree[s.id] === 0);
		const startNodes = roots.length > 0 ? roots.map((r) => r.id) : [states[0].id];

		// BFS to assign levels
		const levels = {};
		const visited = new Set();
		const queue = startNodes.map((id) => ({ id, level: 0 }));
		startNodes.forEach((id) => {
			visited.add(id);
			levels[id] = 0;
		});

		let maxLevel = 0;
		while (queue.length > 0) {
			const { id, level } = queue.shift();
			maxLevel = Math.max(maxLevel, level);
			(adj[id] || []).forEach((nextId) => {
				if (!visited.has(nextId)) {
					visited.add(nextId);
					const parentLevels = [];
					for (const [parentId, children] of Object.entries(adj)) {
						if (children.includes(nextId)) {
							parentLevels.push(levels[parentId] || 0);
						}
					}
					const maxParentLevel = Math.max(...parentLevels, 0);
					levels[nextId] = maxParentLevel + 1;
					queue.push({ id: nextId, level: levels[nextId] });
				}
			});
		}

		// Group by level
		const levelGroups = {};
		states.forEach((s) => {
			const lvl = levels[s.id] !== undefined ? levels[s.id] : maxLevel + 1;
			if (!levelGroups[lvl]) levelGroups[lvl] = [];
			levelGroups[lvl].push(s.id);
		});

		const levelKeys = Object.keys(levelGroups).sort((a, b) => a - b);
		const numLevels = levelKeys.length;
		const maxStatesInLevel = Math.max(...Object.values(levelGroups).map((arr) => arr.length));

		// Calculate spacing - scale based on number of levels
		const spacingX = Math.max(300, Math.min(450, (baseWidth - 200) / Math.max(numLevels, 1)));
		const spacingY = Math.max(
			200,
			Math.min(350, (baseHeight - 200) / Math.max(maxStatesInLevel, 1)),
		);

		const diagramWidth = (numLevels - 1) * spacingX + defaultWidth;
		const diagramHeight = (maxStatesInLevel - 1) * spacingY + defaultHeight;

		const startX = Math.max(padding, (baseWidth - diagramWidth) / 2);
		const startY = Math.max(padding, (baseHeight - diagramHeight) / 2);

		// Order states to minimize crossings
		const orderedLevels = {};
		if (levelKeys.length > 0) {
			const firstLevel = levelKeys[0];
			orderedLevels[firstLevel] = [...levelGroups[firstLevel]];
		}

		for (let i = 1; i < levelKeys.length; i++) {
			const currentLevel = levelKeys[i];
			const prevLevel = levelKeys[i - 1];
			const currentNodes = levelGroups[currentLevel];
			const prevNodes = orderedLevels[prevLevel] || levelGroups[prevLevel];

			const nodeScores = currentNodes.map((nodeId) => {
				const parents = [];
				for (const [parentId, children] of Object.entries(adj)) {
					if (children.includes(nodeId)) {
						const parentIndex = prevNodes.indexOf(parentId);
						if (parentIndex !== -1) parents.push(parentIndex);
					}
				}
				if (parents.length === 0) return { nodeId, score: prevNodes.length / 2 };
				const sortedParents = parents.sort((a, b) => a - b);
				const median = sortedParents[Math.floor(sortedParents.length / 2)];
				return { nodeId, score: median };
			});

			nodeScores.sort((a, b) => a.score - b.score);
			orderedLevels[currentLevel] = nodeScores.map((item) => item.nodeId);
		}

		// Place states
		this.statePositions = {};
		levelKeys.forEach((levelKey, li) => {
			const nodeIds = orderedLevels[levelKey] || levelGroups[levelKey];
			const count = nodeIds.length;
			const x = startX + li * spacingX + defaultWidth / 2;

			nodeIds.forEach((id, ni) => {
				const groupHeight = (count - 1) * spacingY + defaultHeight;
				const yOffset = Math.max(0, (maxStatesInLevel * spacingY - groupHeight) / 2);
				const y = startY + ni * spacingY + yOffset + defaultHeight / 2;

				let posX = x - defaultWidth / 2;
				let posY = y - defaultHeight / 2;

				if (this.positions && this.positions[id]) {
					posX = this.positions[id].x;
					posY = this.positions[id].y;
				}

				this.statePositions[id] = {
					x: posX,
					y: posY,
					width: defaultWidth,
					height: defaultHeight,
					centerX: posX + defaultWidth / 2,
					centerY: posY + defaultHeight / 2,
				};
			});
		});

		this._stateMap = stateMap;
		this._defaults = this.data.defaults || {};
		this._layout = layout;
		this._transitions = transitions;
	}

	generateSVG() {
		if (!this.data || !this.statePositions || Object.keys(this.statePositions).length === 0) {
			return '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><text>No diagram</text></svg>';
		}

		const bgColor = this.data.style?.background || '#1e1e1e';
		let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${this.width}" height="${this.height}">`;
		svg += `<defs>`;
		svg += `<filter id="shadow">`;
		svg += `<feDropShadow dx="${2 * this._scale}" dy="${2 * this._scale}" stdDeviation="${4 * this._scale}" flood-opacity="0.3"/>`;
		svg += `</filter>`;
		svg += `</defs>`;
		svg += `<rect width="100%" height="100%" fill="${bgColor}"/>`;

		// Draw transitions
		svg += this.generateTransitionSVG();

		// Draw states
		svg += this.generateStateSVG();

		svg += '</svg>';
		return svg;
	}

	generateStateSVG() {
		const defaults = this._defaults.state || {};
		const terminalDefaults = this._defaults.terminal || {};
		const stallDefaults = this._defaults.stall || {};
		let svg = '';

		Object.keys(this.statePositions).forEach((id) => {
			const pos = this.statePositions[id];
			const stateData = this._stateMap[id];
			const type = stateData.type || 'regular';

			let bgColor = defaults.color || '#2d2d2d';
			let borderColor = defaults.borderColor || '#666666';

			if (type === 'terminal') {
				bgColor = terminalDefaults.color || '#c62828';
				borderColor = terminalDefaults.borderColor || '#ef5350';
			} else if (type === 'stall') {
				bgColor = stallDefaults.color || '#1565c0';
				borderColor = stallDefaults.borderColor || '#42a5f5';
			}
			if (stateData.color) bgColor = stateData.color;

			// Scale all size-related properties
			const borderRadius = Math.max(2, (defaults.borderRadius || 8) * this._scale);
			const borderWidth = Math.max(0.5, (defaults.borderWidth || 2) * this._scale);

			// Text size - scale with the diagram, but keep it readable
			const baseFontSize = defaults.fontSize || 14;
			const fontSize = baseFontSize * this._scale * text_scale; // Slightly larger for readability
			const fontWeight = defaults.fontWeight || 'bold';
			const fontFamily = defaults.fontFamily || 'Arial';

			const x = pos.x,
				y = pos.y,
				w = pos.width,
				h = pos.height;

			// Rounded rectangle with shadow
			svg += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${borderRadius}"`;
			svg += ` fill="${bgColor}" stroke="${borderColor}" stroke-width="${borderWidth}"`;
			svg += ` filter="url(#shadow)"/>`;

			// Text with wrapping
			const textColor = this.getContrastColor(bgColor);
			const label = stateData.label || id;
			const maxWidth = w - 20;
			const lines = this.wrapTextSVG(label, maxWidth, fontSize);
			const lineHeight = fontSize * 1.3;
			const totalHeight = lines.length * lineHeight;
			const startY = y + h / 2 - totalHeight / 2 + lineHeight / 2;

			lines.forEach((line, index) => {
				const lineY = startY + index * lineHeight;
				svg += `<text x="${x + w / 2}" y="${lineY}" text-anchor="middle" dominant-baseline="middle"`;
				svg += ` fill="${textColor}" font-family="${fontFamily}" font-size="${fontSize}" font-weight="${fontWeight}">`;
				svg += this.escapeSVG(line);
				svg += `</text>`;
			});

			// Type indicator - scale icon size
			const iconSize = Math.max(10, 12 * this._scale);
			if (type === 'terminal') {
				svg += `<text x="${x + w / 2}" y="${y - 4}" text-anchor="middle" dominant-baseline="bottom"`;
				svg += ` fill="${textColor}" font-family="Arial" font-size="${iconSize}px">⏹</text>`;
			} else if (type === 'stall') {
				svg += `<text x="${x + w / 2}" y="${y - 4}" text-anchor="middle" dominant-baseline="bottom"`;
				svg += ` fill="${textColor}" font-family="Arial" font-size="${iconSize}px">⏸</text>`;
			}
		});

		return svg;
	}

	generateTransitionSVG() {
		const transitions = this._transitions || [];
		const defaults = this._defaults.transition || {};
		const arrowColor = defaults.color || '#888888';

		// Scale transition properties
		const baseLineWidth = defaults.lineWidth || 2;
		const lineWidth = Math.max(0.5, baseLineWidth * this._scale);

		const baseFontSize = defaults.fontSize || 11;
		const fontSize = baseFontSize * this._scale * text_scale;
		const fontFamily = defaults.fontFamily || 'Arial';

		const arrowCurve = 60 * this._scale;
		let svg = '';

		transitions.forEach((t) => {
			const fromPos = this.statePositions[t.from];
			const toPos = this.statePositions[t.to];
			if (!fromPos || !toPos) return;

			const fromX = fromPos.centerX;
			const fromY = fromPos.centerY;
			const toX = toPos.centerX;
			const toY = toPos.centerY;

			const dx = toX - fromX;
			const dy = toY - fromY;
			const len = Math.sqrt(dx * dx + dy * dy);
			const nx = -dy / len;
			const ny = dx / len;
			const curveAmount = Math.min(arrowCurve, len * 0.35);
			const cpX = (fromX + toX) / 2 + nx * curveAmount;
			const cpY = (fromY + toY) / 2 + ny * curveAmount;

			const color = t.color || arrowColor;

			// Draw the curved line
			svg += `<path d="M ${fromX} ${fromY} Q ${cpX} ${cpY} ${toX} ${toY}"`;
			svg += ` stroke="${color}" stroke-width="${lineWidth}" fill="none"`;

			const style = t.arrowStyle || defaults.arrowStyle || 'solid';
			if (style === 'dashed') {
				const dashLen = Math.max(4, 8 * this._scale);
				const gapLen = Math.max(3, 6 * this._scale);
				svg += ` stroke-dasharray="${dashLen},${gapLen}"`;
			}
			svg += ` />`;

			// Draw chevron - scale size
			svg += this.generateChevronSVG(fromX, fromY, cpX, cpY, toX, toY, color);

			// Draw label with rotated background
			if (t.label) {
				const t_pos = 0.4;
				const labelX =
					(1 - t_pos) * (1 - t_pos) * fromX +
					2 * (1 - t_pos) * t_pos * cpX +
					t_pos * t_pos * toX;
				const labelY =
					(1 - t_pos) * (1 - t_pos) * fromY +
					2 * (1 - t_pos) * t_pos * cpY +
					t_pos * t_pos * toY;

				const tangentX = 2 * (1 - t_pos) * (cpX - fromX) + 2 * t_pos * (toX - cpX);
				const tangentY = 2 * (1 - t_pos) * (cpY - fromY) + 2 * t_pos * (toY - cpY);
				const angle = Math.atan2(tangentY, tangentX);
				const normalX = -Math.sin(angle);
				const normalY = Math.cos(angle);

				const offsetDistance = Math.max(12, 18 * this._scale);
				const finalX = labelX + normalX * offsetDistance;
				const finalY = labelY + normalY * offsetDistance;

				const labelColor = t.color || arrowColor;

				// Measure text for background
				const charWidth = fontSize * 0.6;
				const textWidth = t.label.length * charWidth;
				const padding = 12 * this._scale;
				const tw = textWidth + padding * 2;
				const th = fontSize + padding;

				// Rotate the entire group (background + text)
				const angleDeg = (angle * 180) / Math.PI;
				svg += `<g transform="translate(${finalX}, ${finalY}) rotate(${angleDeg})">`;

				// Background
				const bgRadius = Math.max(2, 4 * this._scale);
				svg += `<rect x="${-tw / 2}" y="${-th / 2}" width="${tw}" height="${th}" rx="${bgRadius}"`;
				svg += ` fill="rgba(30,30,30,0.9)" stroke="rgba(255,255,255,0.15)" stroke-width="${Math.max(0.5, this._scale)}"/>`;

				// Label text
				svg += `<text x="0" y="0" text-anchor="middle" dominant-baseline="middle"`;
				svg += ` fill="${labelColor}" font-family="${fontFamily}" font-size="${fontSize}">`;
				svg += this.escapeSVG(t.label);
				svg += `</text>`;

				svg += `</g>`;
			}
		});

		return svg;
	}

	generateChevronSVG(fromX, fromY, cpX, cpY, toX, toY, color) {
		const t = 0.5;
		const x = (1 - t) * (1 - t) * fromX + 2 * (1 - t) * t * cpX + t * t * toX;
		const y = (1 - t) * (1 - t) * fromY + 2 * (1 - t) * t * cpY + t * t * toY;
		const tangentX = 2 * (1 - t) * (cpX - fromX) + 2 * t * (toX - cpX);
		const tangentY = 2 * (1 - t) * (cpY - fromY) + 2 * t * (toY - cpY);
		const angle = Math.atan2(tangentY, tangentX);

		// Scale chevron size
		const size = Math.max(4, 10 * this._scale);
		const spread = 0.6;

		const p1x = x - size * Math.cos(angle - spread);
		const p1y = y - size * Math.sin(angle - spread);
		const p2x = x - size * Math.cos(angle + spread);
		const p2y = y - size * Math.sin(angle + spread);

		const lineWidth = Math.max(1, 2.5 * this._scale);
		return `<polyline points="${p1x},${p1y} ${x},${y} ${p2x},${p2y}" stroke="${color}" stroke-width="${lineWidth}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
	}

	wrapTextSVG(text, maxWidth, fontSize) {
		const words = text.split(' ');
		const lines = [];
		let currentLine = '';
		const charWidth = fontSize * 0.6;

		for (let i = 0; i < words.length; i++) {
			const testLine = currentLine + (currentLine ? ' ' : '') + words[i];
			const width = testLine.length * charWidth;

			if (width > maxWidth && currentLine) {
				lines.push(currentLine);
				currentLine = words[i];
			} else {
				currentLine = testLine;
			}
		}
		if (currentLine) lines.push(currentLine);
		return lines.length > 0 ? lines : [text];
	}

	escapeSVG(text) {
		return text
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&apos;');
	}

	getContrastColor(hexColor) {
		const hex = hexColor.replace('#', '');
		const r = parseInt(hex.substr(0, 2), 16);
		const g = parseInt(hex.substr(2, 2), 16);
		const b = parseInt(hex.substr(4, 6), 16);
		const brightness = (r * 299 + g * 587 + b * 114) / 1000;
		return brightness > 128 ? '#000000' : '#FFFFFF';
	}

	async saveToFile(outputPath, format = 'png') {
		const svg = this.generateSVG();

		// Save SVG for debugging
		const svgPath = outputPath.replace(/\.[^.]+$/, '.svg');
		fs.writeFileSync(svgPath, svg);

		const buffer = Buffer.from(svg);

		if (format === 'svg') {
			fs.writeFileSync(outputPath, buffer);
			return outputPath;
		}

		try {
			const image = sharp(buffer, { density: 300 });

			if (format === 'png') {
				await image.png().toFile(outputPath);
			} else if (format === 'jpg' || format === 'jpeg') {
				await image.jpeg({ quality: 95 }).toFile(outputPath);
			}
		} catch (error) {
			console.error(chalk.red('Sharp conversion error:'), error.message);
			console.log(chalk.yellow('Falling back to saving SVG file only...'));
			return svgPath;
		}

		return outputPath;
	}
}

// ============================================================
// CLI COMMANDS
// ============================================================

program.name('diagram-gen').description('Generate diagrams from JSON files').version('1.0.0');

program
	.command('generate')
	.alias('g')
	.description('Generate a diagram from a JSON file')
	.argument('<input>', 'Input JSON file path')
	.argument('[output]', 'Output image file path (default: output.png)')
	.option('-w, --width <number>', 'Image width in pixels', '1920')
	.option('-h, --height <number>', 'Image height in pixels', '1080')
	.option('-f, --format <format>', 'Output format (png, jpg, svg)', 'svg')
	.option('-p, --positions <file>', 'JSON file with state positions')
	.option('-q, --quiet', 'Suppress progress output')
	.action(async (input, output, options) => {
		const spinner = ora('Loading diagram...').start();

		try {
			const inputContent = fs.readFileSync(input, 'utf8');
			let diagramData;
			let positions = null;

			try {
				const parsed = JSON.parse(inputContent);
				if (parsed.type === 'diagram_export') {
					diagramData = parsed.json;
					positions = parsed.positions || null;
					if (!options.quiet) {
						spinner.text = `Loaded exported diagram: ${parsed.name || 'unnamed'}`;
					}
				} else {
					diagramData = parsed;
					if (!options.quiet) {
						spinner.text = 'Loaded raw diagram JSON';
					}
				}
			} catch (e) {
				throw new Error('Invalid JSON file');
			}

			if (options.positions) {
				const posContent = fs.readFileSync(options.positions, 'utf8');
				positions = JSON.parse(posContent);
			}

			const outputPath = output || 'output.png';
			const format = options.format.toLowerCase();
			const width = parseInt(options.width);
			const height = parseInt(options.height);

			if (!diagramData.states) {
				throw new Error('Diagram data must contain "states" array');
			}

			spinner.text = 'Generating diagram...';

			const generator = new DiagramSVGGenerator(width, height, diagramData, positions);
			const result = await generator.saveToFile(outputPath, format);

			spinner.succeed(chalk.green(`✓ Diagram saved to ${chalk.bold(result)}`));

			if (!options.quiet) {
				const stats = fs.statSync(result);
				console.log(chalk.gray(`  Resolution: ${width}x${height}`));
				console.log(chalk.gray(`  Format: ${format.toUpperCase()}`));
				console.log(chalk.gray(`  File size: ${(stats.size / 1024).toFixed(1)} KB`));
				console.log(chalk.gray(`  States: ${diagramData.states.length}`));
				console.log(chalk.gray(`  Transitions: ${(diagramData.transitions || []).length}`));
				if (format !== 'svg') {
					console.log(
						chalk.gray(`  SVG debug: ${outputPath.replace(/\.[^.]+$/, '.svg')}`),
					);
				}
			}
		} catch (error) {
			spinner.fail(chalk.red(`Error: ${error.message}`));
			if (!options.quiet) {
				console.error(chalk.gray(error.stack));
			}
			process.exit(1);
		}
	});

program
	.command('info')
	.alias('i')
	.description('Show information about a diagram file')
	.argument('<input>', 'Input JSON file path')
	.action((input) => {
		try {
			const content = fs.readFileSync(input, 'utf8');
			const data = JSON.parse(content);

			let diagramData, positions, name;
			if (data.type === 'diagram_export') {
				diagramData = data.json;
				positions = data.positions;
				name = data.name || 'unnamed';
			} else {
				diagramData = data;
				name = path.basename(input, '.json');
			}

			console.log(chalk.bold('\n📊 Diagram Information:'));
			console.log(`  Name: ${chalk.cyan(name)}`);
			console.log(`  States: ${chalk.yellow(diagramData.states.length)}`);
			console.log(`  Transitions: ${chalk.yellow((diagramData.transitions || []).length)}`);
			console.log(`  Has positions: ${positions ? chalk.green('✓') : chalk.gray('✗')}`);

			if (diagramData.title) {
				console.log(`  Title: ${chalk.cyan(diagramData.title)}`);
			}
			if (diagramData.description) {
				console.log(`  Description: ${chalk.gray(diagramData.description)}`);
			}
		} catch (error) {
			console.error(chalk.red(`Error: ${error.message}`));
			process.exit(1);
		}
	});

program.parse();

if (!process.argv.slice(2).length) {
	program.help();
}
