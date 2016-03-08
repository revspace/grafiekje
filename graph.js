"use strict";

const INFLUX_URL = "http://local.roysmeding.nl:8086/query";
const INFLUX_DATABASE = "mqtt";

const POINT_SIZE = 5;
const UPDATE_INTERVAL = 2000;

const MARGIN = {top: 10, right: 60, bottom: 30, left: 60},
    FULL_WIDTH   = 960, FULL_HEIGHT = 500,
    GRAPH_WIDTH  = FULL_WIDTH - MARGIN.left - MARGIN.right,
    GRAPH_HEIGHT = FULL_HEIGHT - MARGIN.top - MARGIN.bottom;

const TIME_SCALES = [
		["10s",           10000],
		["1m",          60*1000],
		["10m",      10*60*1000],
		["1h",       60*60*1000],
		["6h",     6*60*60*1000],
		["1d",    24*60*60*1000],
		["1w",  7*24*60*60*1000]
	].reverse();

var influxTime = d3.time.format.iso;

var spaceState = [];

function influxQuery(query, callback) {
	let full_url = INFLUX_URL + '?db=' + encodeURIComponent(INFLUX_DATABASE) + '&q=' + encodeURIComponent(query).replace("%20","+");
	d3.json(full_url, callback);
}

function sensibleRange(array, accessor) {
	let sorted = array.map(accessor).sort(d3.ascending);
	return [d3.quantile(sorted, 0.001), d3.quantile(sorted, 0.999)];
}

function autoScaleX(graph) {
	let allData = d3.merge(graph.data);
	let xExtents = d3.extent(allData, function(d) { return d.x; });

	graph.xScale.domain(xExtents).nice();
	graph.zoom.x(graph.xScale);

	redraw(graph);
}

function autoScaleY(graph) {
	let xDomain = graph.xScale.domain().map(function(t) { return t.getTime(); });
	let allData = d3.merge(graph.data).filter(function(d) { return (d.x.getTime() >= xDomain[0]) && (d.x.getTime() <= xDomain[1]); });
	let yExtents = sensibleRange(allData, function(d) { return d.y; });

	graph.yScale.domain(yExtents).nice();

	redraw(graph);
}

function autoScale(graph) {
	let allData = d3.merge(graph.data);

	let xExtents = d3.extent(allData, function(d) { return d.x; }),
	    yExtents = sensibleRange(allData, function(d) { return d.y; });

	graph.xScale.domain(xExtents).nice();
	graph.yScale.domain(yExtents).nice();

	graph.zoom.x(graph.xScale);

	redraw(graph);
}

function setXRes(graph, width) {
	let cur    = graph.xScale.domain().map(function(d) { return d.getTime(); });
	let center = (cur[0]+cur[1])/2;
	graph.xScale.domain([new Date(center-width/2), new Date(center+width/2)]);

	scrollX(graph);
}

function scrollX(graph) {
	let curX = graph.xScale.domain().map(function(d) { return d.getTime(); });
	let endX = new Date(), startX = new Date(endX.getTime() - (curX[1] - curX[0]));

	graph.xScale.domain([startX, endX]);

	graph.zoom.x(graph.xScale);

	redraw(graph);
}

function redraw(graph) {
	let g = d3.select(graph);
	
	let xDom  = graph.xScale.domain().map(function(d) { return d.getTime(); });
	let xSize = xDom[1] - xDom[0];

	window.clearTimeout(graph.redrawTimer);

	let redrawInterval = xSize/GRAPH_WIDTH;
	graph.redrawTimer = window.setTimeout(function() { scrollX(graph) }, redrawInterval);

	g.select(".xAxis").call(graph.xAxis);
	g.select(".yAxis").call(graph.yAxis);

	let ctx = g.select("canvas")[0][0].getContext("2d");
	ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

	spaceState.forEach(function(block,idx) {
		switch(block[2]) {
			case "open":   ctx.fillStyle = "rgba(0,256,0,0.2)";   break;
			case "closed": ctx.fillStyle = "rgba(256,0,0,0.2)";   break;
			default:       ctx.fillStyle = "rgba(256,256,0,0.2)"; break;
		}

		let start = block[0] ? graph.xScale(block[0]) : 0,
		    end   = block[1] ? graph.xScale(block[1]) : graph.xScale(new Date());

		if((start > ctx.canvas.width) || (end < 0)) return;

		ctx.fillRect(start, 0, end-start, ctx.canvas.height);

		let nextBlock = spaceState[idx+1];
		if(!nextBlock) return;
		else if(nextBlock[2] == "open")   ctx.strokeStyle = "rgba(0,256,0,0.4)";
		else if(nextBlock[2] == "closed") ctx.strokeStyle = "rgba(256,0,0,0.4)";
		else return;

		ctx.lineWidth = 2;
		ctx.beginPath();
		ctx.moveTo(end, 0);
		ctx.lineTo(end, ctx.canvas.height);
		ctx.stroke();
	});

	let symbol = d3_shape.symbol()
		.size(6);

	graph.data.forEach(function(data, idx) {
		let c = d3.rgb(graph.colorScale(graph.topics[idx]));

		ctx.beginPath();
		graph.dataLine.context(ctx)(data);
		ctx.strokeStyle = 'rgba('+c.r+','+c.g+','+c.b+',0.7)';
		ctx.lineWidth = 1;
		ctx.stroke();

/*		ctx.beginPath();
		graph.dataArea.context(ctx)(data);
		ctx.fillStyle = 'rgba('+c.r+','+c.g+','+c.b+',0.3)';
		ctx.fill();*/

		ctx.fillStyle = c.toString();
		if(xSize < (2*60*60*1000)) {
			data
				.filter(function(d) { let t = d.x.getTime(); return (t > xDom[0]) && (t < xDom[1]); })
				.forEach(function(d) {
				ctx.beginPath();
				ctx.setTransform(1,0,0,1,graph.xScale(d.x),graph.yScale(d.y));
				symbol.context(ctx)();
				ctx.fill();
			});
			ctx.setTransform(1,0,0,1,0,0);
		}
	});
}

function graphDataReceived(graph, error, json) {
	if(error) return console.warn(error);

	if(!json.results) return console.warn("Results field lacking from InfluxDB query response");

	let first_time = !(graph.data[0].length);

	for(let result of json.results) {
		if(!result.series) continue;	// empty data set

		let topic = result.series[0].name;
		let topicIndex = graph.topics.indexOf(topic);

		if(topicIndex == -1) return console.warn("Got data for unknown topic "+topic+".");

		let newData = result.series[0].values.map(function(d) { return { "x":influxTime.parse(d[0]), "y":d[1] }; });
		Array.prototype.push.apply(graph.data[topicIndex], newData);

		graph.lastUpdate[topicIndex] = newData[newData.length-1].x;
	}

	if(first_time) {
		setXRes(graph, 10*60*1000);
		autoScaleY(graph);
	}
}

function spaceStateDataReceived(error, json) {
	if(error) return console.warn(error);
	if(!json.results) return console.warn("Results field lacking from InfluxDB query response");

	let result = json.results[0];
	if(!result.series)
		return;

	let newData = result.series[0].values;
	
	let offset, prevTime, prevState;
	if(spaceState.length) {
		let prevBlock = spaceState.pop();
		prevTime  = prevBlock[0];
		prevState = prevBlock[2];
	} else {
		spaceState = []
		prevTime   = null;
		prevState  = null;
	}

	newData.forEach(function(record, idx) {
		let time  = influxTime.parse(record[0]),
		    state = record[1];

		if(prevState != state) {
			spaceState.push([prevTime, time, prevState]);
			prevState = state;
			prevTime = time;
		}
	});

	spaceState.push([prevTime, null, prevState]);

	d3.selectAll(".graph").each(function() { redraw(this); });
}

function updateGraph(graph) {
	let query = "";
	graph.topics.forEach(function(topic, idx) {
		query += "SELECT value FROM \""+topic.replace('"', '\\"')+"\"";
		if(graph.lastUpdate[idx])
			query += " WHERE time > '" + influxTime(graph.lastUpdate[idx]) + "'";
		query += ';';
	});
	influxQuery(query, function(error, json) { return graphDataReceived(graph, error, json); });
	graph.updateTimer = window.setTimeout(updateGraph, UPDATE_INTERVAL, graph);
}

function updateSpaceState() {
	let query;
	if(spaceState.length)
		query = 'SELECT * FROM "revspace/state" WHERE time > \''+influxTime(spaceState[spaceState.length-1][0])+'\' + 1s;';
	else
		query = 'SELECT * FROM "revspace/state";';
	influxQuery(query, spaceStateDataReceived);
	window.setTimeout(updateSpaceState, UPDATE_INTERVAL);
}

function formatValue(unit) {
	return function(value) {
		let prefix = d3.formatPrefix(value);
		return prefix.scale(value)+"\u202F"+prefix.symbol+unit;
	} ;
}

function setupGraph() {
	let graph = this, g = d3.select(this);

	let data = this.dataset;

	graph.topicPrefix = data.prefix ? data.prefix : "";
	graph.topics      = data.topics.split(/,\s*/).map(function(t) { return graph.topicPrefix+t; });
	graph.names       = data.topics.split(/,\s*/);

	graph.unit   = data.unit   ? data.unit                  : "";
	graph.yRange = data.range  ? data.range.split(/-\s*/,2) : undefined;
	graph.title  = data.title  ? data.title                 : "";

	graph.lastUpdate = {};

	graph.xScale = d3.time.scale()
		.domain([new Date(), new Date()])
		.range([0,GRAPH_WIDTH]);

	switch(data.scale) {
		case 'log':    graph.yScale = d3.scale.log();    break;
		case 'linear': graph.yScale = d3.scale.linear(); break;
		default:       graph.yScale = d3.scale.linear(); break;
	}

	switch(data.interp) {
		case 'stepBefore': graph.curve = d3_shape.curveStepBefore; break;
		case 'basis':      graph.curve = d3_shape.curveBasis;      break;
		case 'bundle':     graph.curve = d3_shape.curveBundle;     break;
		case 'natural':    graph.curve = d3_shape.curveNatural;    break;
		case 'catmullRom': graph.curve = d3_shape.curveCatmullRom; break;
		case 'cardinal':   graph.curve = d3_shape.curveCardinal;   break;
		default:           graph.curve = d3_shape.curveLinear;     break;
	}
	
	graph.yScale.domain(graph.yRange);
	graph.yScale.range([GRAPH_HEIGHT,0]);

	graph.colorScale = d3.scale.category10();

	graph.zoom = d3.behavior.zoom()
		.x(graph.xScale)
		.on("zoom", function() { autoScaleY(graph); } );

	graph.dataLine = d3_shape.line()
		.x(function(d) { return graph.xScale(d.x); })
		.y(function(d) { return graph.yScale(d.y); })
		.curve(graph.curve);

/*	graph.dataArea = d3_shape.area()
		.x(function(d) { return graph.xScale(d.x); })
		.y(function(d) { return graph.yScale(d.y); })
		.y1(function(d) { return graph.yScale(0); })
		.curve(graph.curve);*/

	let legend = g.append("ul")
		.attr("class", "sidebar legend");

	graph.names.forEach(function(name, idx) {
		let topic = graph.topics[idx];
		legend.append("li")
			.text(name)
			.attr("title", topic)
			.style("background", graph.colorScale(topic));
	});

	let controls = g.append("div")
		.attr("class", "sidebar controls");

	controls.append("button")
		.text("all time")
		.on("click", function() { autoScale(graph); });

	for(let ts of TIME_SCALES) {
		controls.append("button")
			.text(ts[0])
			.on("click", function() { setXRes(graph, ts[1]); });
	}

	graph.xAxis = d3.svg.axis()
			.scale(graph.xScale)
			.orient("bottom")
			.tickFormat(graph.xScale.tickFormat())
			.ticks(10)
			.tickSize(-GRAPH_HEIGHT)
			.tickPadding(8);

	graph.yAxis = d3.svg.axis()
			.scale(graph.yScale)
			.orient("left")
			.ticks(5)
			.tickFormat(formatValue(graph.unit));

	let axes = g.select(".axes")
		.attr("width",  FULL_WIDTH)
		.attr("height", FULL_HEIGHT)
		.attr("viewbox", (-MARGIN.left)+" "+(-MARGIN.top)+" "+FULL_WIDTH+" "+FULL_HEIGHT);

	axes.append("g")
		.attr("class", "axis xAxis")
		.attr("transform", "translate("+MARGIN.left+","+(MARGIN.top+GRAPH_HEIGHT)+")")
		.call(graph.xAxis);

	axes.append("g")
		.attr("class", "axis yAxis")
		.attr("transform", "translate("+MARGIN.left+","+MARGIN.top+")")
		.call(graph.yAxis);

	let canvas = g.select("canvas")
		.attr("width",  GRAPH_WIDTH)
		.attr("height", GRAPH_HEIGHT)
		.style("left",  MARGIN.left)
		.style("top",   MARGIN.top)
		.call(graph.zoom);

	graph.data = graph.topics.map(function(topic) { return []; });

	updateGraph(graph);
}

function setup() {
	d3.selectAll(".graph").each(setupGraph);
	updateSpaceState();
}

window.addEventListener("load", setup);
