"use strict";

var INFLUX_URL = "http://192.168.1.14:8086/query";
var INFLUX_DATABASE = "mqtt";

var POINT_SIZE = 5;
var UPDATE_INTERVAL = 10000;

var MARGIN = {top: 30, right: 80, bottom: 30, left: 80},
    GRAPH_WIDTH  = 960 - MARGIN.left - MARGIN.right,
    GRAPH_HEIGHT  = 500 - MARGIN.top - MARGIN.bottom;

var influxTime = d3.time.format.iso;

var lastUpdateFormatter = d3.time.format("%Y-%m-%d %H:%M:%S");

function influxQuery(query, callback) {
	let full_url = INFLUX_URL + '?db=' + encodeURIComponent(INFLUX_DATABASE) + '&q=' + encodeURIComponent(query).replace("%20","+");
	d3.json(full_url, callback);
}

function sensibleRange(array, accessor) {
	let sorted = array.map(accessor).sort(d3.ascending);
	return [d3.quantile(sorted, 0.01), d3.quantile(sorted, 0.99)];
}

function autoScale(graph) {
	let allData = d3.selectAll("g.datapoints path").data();

	let xExtents = d3.extent(allData, function(d) { return d.x; }),
	    yExtents = sensibleRange(allData, function(d) { return d.y; });

	graph.xScale.domain(xExtents).nice(d3.time.hour);
	graph.yScale.domain(yExtents).nice();

	graph.zoom.x(graph.xScale)
		  .y(graph.yScale);

	updateScales(graph);
}

function pointToScreen(graph) {
	return function(d) {
		return "translate(" + graph.xScale(d.x) + ","+graph.yScale(d.y)+")";
	}
}

function updateScales(graph) {
	let g = d3.select(graph);
	g.selectAll("g.datapoints path")
		.attr("transform", pointToScreen(graph));

	g.selectAll("path.dataline")
		.attr("d", graph.dataLine);

	g.select("g.axis--x").call(graph.xAxis);
	g.select("g.axis--y").call(graph.yAxis);
}

function graphDataReceived(graph, error, json) {
	if(error) return console.warn(error);

	if(!json.results) return console.warn("Results field lacking from InfluxDB query response");

	var first_time = !(d3.select(graph).selectAll("g.datapoints path").data().length);

	for(let result of json.results) {
		if(!result.series) continue;	// empty data set

		let topic = result.series[0].name;
		let topicIndex = graph.topics.indexOf(topic);

		if(topicIndex == -1) return console.warn("Got data for unknown topic "+topic+".");

		let dataGroup = d3.select(graph).select('g[data-topic="'+topic.replace('"','\\"')+'"]');

		let data = result.series[0].values.map(function(d) { return { "x":influxTime.parse(d[0]), "y":d[1] }; });

		let enter = dataGroup.select("g.datapoints").selectAll("path")
			.data(data)
			.enter().append("path")
			.attr("d", d3.svg.symbol().size(POINT_SIZE));

		let dl = dataGroup.select("path.dataline");

		if(first_time) {
			dl.datum(data);
		} else {
			enter.attr("transform", pointToScreen(graph));
			
			Array.prototype.push.apply(dl.datum(), data);
			dl.attr("d", graph.dataLine);
		}

		graph.lastUpdate[topicIndex] = new Date();
	}

	if(first_time) {
		autoScale(graph);
		d3.select(graph).selectAll("g.datapoints path")
			.attr("transform", pointToScreen(graph));
		d3.select(graph).selectAll("path.dataline")
			.attr("d", graph.dataLine);
	}
}

function spaceStateDataReceived(error, json) {

}

function updateGraph(graph) {
	let query = "";
	graph.topics.forEach(function(topic, idx) {
		query += "SELECT value FROM \""+topic.replace('"', '\\"')+"\"";
		if(graph.lastUpdate[idx])
			query += " WHERE time >= '" + influxTime(graph.lastUpdate[idx]) + "'";
		else
			query += " WHERE time >= now() - 24h";
		query += ';';
	});
	influxQuery(query, function(error, json) { return graphDataReceived(graph, error, json); });
	graph.updateTimer = window.setTimeout(updateGraph, UPDATE_INTERVAL, graph);
}

function formatValue(unit) {
	return function(value) {
		let prefix = d3.formatPrefix(value);
		return prefix.scale(value)+"\u202F"+prefix.symbol+unit;
	} ;
}

function setupGraph() {
	let graph = this;

	let data = this.dataset;

	graph.topicPrefix = data.prefix ? data.prefix : "";
	graph.topics      = data.topics.split(/,\s*/).map(function(t) { return graph.topicPrefix+t; });
	graph.names       = data.topics.split(/,\s*/);

	graph.unit   = data.unit   ? data.unit                  : "";
	graph.yRange = data.range  ? data.range.split(/-\s*/,2) : undefined;
	graph.interp = data.interp ? data.interp                : "linear";
	graph.title  = data.title  ? data.title                 : "";

	graph.lastUpdate = {};

	let svg = d3.select(graph).append("svg")

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
		.on("zoom", function() { updateScales(graph); } );

	graph.dataLine = d3.svg.line()
		.x(function(d) { return graph.xScale(d.x); })
		.y(function(d) { return graph.yScale(d.y); })
		.interpolate(graph.interp);

	svg.attr("viewBox", "-"+MARGIN.left + " -" + MARGIN.top + " " + (GRAPH_WIDTH+MARGIN.left+MARGIN.right) + " " + (GRAPH_HEIGHT+MARGIN.top+MARGIN.bottom))
		.call(graph.zoom);

	svg.append("clipPath")
		.attr("id", "clip")
		.append("rect")
		.attr("x", 0)
		.attr("y", 0)
		.attr("width", GRAPH_WIDTH)
		.attr("height", GRAPH_HEIGHT);

	svg.append("text")
		.attr("class", "title")
		.attr("x", 10)
		.attr("y", 10)
		.text(graph.title);

	let legend = d3.select(graph).append("ul")
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
			.ticks(15)
			.tickSize(-GRAPH_HEIGHT);

	graph.yAxis = d3.svg.axis()
			.scale(graph.yScale)
			.orient("left")
			.tickFormat(formatValue(graph.unit))
			.ticks(10)
			.tickSize(-GRAPH_WIDTH);

	svg.append("g")
		.attr("class", "axis axis--x")
		.attr("transform", "translate(0," + GRAPH_HEIGHT + ")")
		.call(graph.xAxis);

	svg.append("g")
		.attr("class", "axis axis--y")
		.attr("transform", "translate(0,0)")
		.call(graph.yAxis);

	for(let topic of graph.topics) {
		let group = svg.append("g")
			.attr("class", "dataSet")
			.attr("data-topic", topic)
			.style("fill", graph.colorScale(topic))
			.style("stroke", graph.colorScale(topic));

		group.append("g")
			.attr("class", "datapoints")
			.attr("clip-path", "url(#clip)");

		group.append("path")
			.attr("class", "dataline");
	}

	d3.select(graph).append("footer");

	updateGraph(graph);
}

function setup() {
	d3.selectAll(".graph").each(setupGraph);
}

window.addEventListener("load", setup);
