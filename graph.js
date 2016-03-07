"use strict";

const INFLUX_URL = "http://192.168.1.14:8086/query";
const INFLUX_DATABASE = "mqtt";

const POINT_SIZE = 5;
const UPDATE_INTERVAL = 10000;

const MARGIN = {top: 10, right: 60, bottom: 30, left: 60},
    FULL_WIDTH   = 960, FULL_HEIGHT = 500,
    GRAPH_WIDTH  = FULL_WIDTH - MARGIN.left - MARGIN.right,
    GRAPH_HEIGHT = FULL_HEIGHT - MARGIN.top - MARGIN.bottom;

var influxTime = d3.time.format.iso;

var spaceState = [];

function influxQuery(query, callback) {
	let full_url = INFLUX_URL + '?db=' + encodeURIComponent(INFLUX_DATABASE) + '&q=' + encodeURIComponent(query).replace("%20","+");
	d3.json(full_url, callback);
}

function sensibleRange(array, accessor) {
	let sorted = array.map(accessor).sort(d3.ascending);
	return [d3.quantile(sorted, 0.01), d3.quantile(sorted, 0.99)];
}


function autoScale(graph, data) {
	let xExtents = d3.extent(data, function(d) { return d.x; }),
	    yExtents = sensibleRange(data, function(d) { return d.y; });

	graph.xScale.domain(xExtents).nice(d3.time.hour);
	graph.yScale.domain(yExtents).nice();

	graph.zoom.x(graph.xScale)
		  .y(graph.yScale);

	updateScales(graph);
}

function updateScales(graph) {
	let g = d3.select(graph);
	
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
		    end   = block[1] ? graph.xScale(block[1]) : ctx.canvas.width;

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

	let line = d3_shape.line()
		.x(function(d) { return graph.xScale(d.x); })
		.y(function(d) { return graph.yScale(d.y); })
		.curve(d3_shape.curveStepBefore);

	let symbol = d3_shape.symbol()
		.size(6);

	graph.data.forEach(function(data, idx) {
		let c = d3.rgb(graph.colorScale(graph.topics[idx]));

		ctx.beginPath();
		line.context(ctx)(data);
		ctx.strokeStyle = 'rgba('+c.r+','+c.g+','+c.b+',0.7)';
		ctx.lineWidth = 1;
		ctx.stroke();

		ctx.fillStyle = c.toString();
		data.forEach(function(d) {
			ctx.beginPath();
			ctx.setTransform(1,0,0,1,graph.xScale(d.x),graph.yScale(d.y));
			symbol.context(ctx)();
			ctx.fill();
		});
		ctx.setTransform(1,0,0,1,0,0);
	});
}

function graphDataReceived(graph, error, json) {
	if(error) return console.warn(error);

	if(!json.results) return console.warn("Results field lacking from InfluxDB query response");

	var first_time = !(graph.data[0].length);

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
		let allData = d3.merge(json.results.map(function(r) { return r.series[0].values.map(function(d) { return { "x":influxTime.parse(d[0]), "y":d[1] }; }); }));

		autoScale(graph, allData);
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

	spaceState.push([prevTime, new Date(), prevState]);
}

function updateGraph(graph) {
	let query = "";
	graph.topics.forEach(function(topic, idx) {
		query += "SELECT value FROM \""+topic.replace('"', '\\"')+"\"";
		if(graph.lastUpdate[idx])
			query += " WHERE time > '" + influxTime(graph.lastUpdate[idx]) + "'";
		else
			query += " WHERE time > now() - 24h";
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
		query = 'SELECT * FROM "revspace/state" WHERE time > now() - 24h;';
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
	graph.interp = data.interp ? data.interp                : "linear";
	graph.title  = data.title  ? data.title                 : "";

	graph.lastUpdate = {};

	graph.xScale = d3.time.scale()
		.domain([new Date(), new Date()])
		.range([0,GRAPH_WIDTH]);

	switch(graph.dataset.scale) {
		case 'log':    graph.yScale = d3.scale.log();    break;
		case 'linear': graph.yScale = d3.scale.linear(); break;
		default:       graph.yScale = d3.scale.linear(); break;
	}
	
	graph.yScale.domain(graph.yRange);
	graph.yScale.range([GRAPH_HEIGHT,0]);

	graph.colorScale = d3.scale.category10();

	graph.zoom = d3.behavior.zoom()
		.x(graph.xScale)
		.y(graph.yScale)
		.scaleExtent([0.1, 42])
		.on("zoom", function() { updateScales(graph); } );

	graph.dataLine = d3.svg.line()
		.x(function(d) { return graph.xScale(d.x); })
		.y(function(d) { return graph.yScale(d.y); })
		.interpolate(graph.interp);

	let legend = g.append("ul")
		.attr("class", "legend");

	graph.names.forEach(function(name, idx) {
		let topic = graph.topics[idx];
		legend.append("li")
			.text(name)
			.attr("title", topic)
			.style("background", graph.colorScale(topic));
	});

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
			.ticks(5,formatValue(graph.unit))
			.tickSize(-GRAPH_WIDTH)
			.tickPadding(8);

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
