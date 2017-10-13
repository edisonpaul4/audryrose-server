var path = require('path');
var fs = require('fs');
var streams = require('memory-streams');
var json2csv = require('json2csv');
var moment = require('moment');

var { ProductsModel } = require('./products.model');

exports.ProductsController = new class ProductsController {
  constructor(){ 
    this.ProductsCSV = new Parse.Object.extend('ProductsCSV');
  }

  /**
   * @returns CSV File
   */
  getProductsAsCSV(){

    var createCSV = ({fields, productsRows}) => {
      return new Promise((resolve, reject) => {
        var writer = new streams.WritableStream();
        writer.write(json2csv({ data: productsRows, fields: fields }));
        writer.end();
        var buffer = writer.toBuffer();
        var fileName = 'temp_products.csv';
        var file = new Parse.File(fileName, { base64: buffer.toString('base64', 0, buffer.length) }, 'application/csv')
          .save(null, { useMasterKey: true })
          .then(resolve)
          .catch(reject);
      });
    }

    var parseToCSVRows = responseProducts => {
      return new Promise((resolve, reject) => {

        var fields = ["Dated Added", "Bigcommerce SKU", "Audry Rose Name", "Designer Name", "Designer", "Retail Price", "Wholesale Price", "Class", "Size Scale", "status ", "Act OH", "total awaiting", "Color", "OH size 2", "OH size 2.5", "OH size 3", "OH size 3.5", "OH size 4", "OH size 4.5", "OH size 5", "OH size 6.5", "OH size 6", "OH size 7", "OH size 7.5", "OH size 8", "OH size 8.5", "OH size 9", "OH size 9.5", "OH size 10", "OH size 10.5", "OH size 11", "awating size 2", "awating size 2.5", "awating size 3", "awating size 3.5", "awating size 4", "awating size 4.5", "awating size 5", "awating size 6.5", "awating size 6", "awating size 7", "awating size 7.5", "awating size 8", "awating size 8.5", "awating size 9", "awating size 9.5", "awating size 10", "awating size 10.5", "awating size 11"];

        var productsRows = responseProducts.reduce((allProducts, currentProduct) => {
          var csvRows = allProducts || [];
  
          var currentRow = {
            "Dated Added": moment(currentProduct.createdAt).format("MM-DD-YYYY"),
            "Bigcommerce SKU": currentProduct.sku,
            "Audry Rose Name": currentProduct.name,
            "Designer Name": currentProduct.designerProductName,
            "Designer": typeof currentProduct.designer === 'undefined' ? '' : currentProduct.designer.name,
            "Retail Price": typeof currentProduct.price === 'undefined' ? 0 : currentProduct.price.toFixed(2),
            "Wholesale Price": typeof currentProduct.wholesalePrice === 'undefined' ? 0 : currentProduct.wholesalePrice.toFixed(2),
            "Class": typeof currentProduct.classification === 'undefined' ? '' : currentProduct.classification.name,
            "Size Scale": currentProduct.sizeScale,
            "status ": currentProduct.availability,
            "Act OH": currentProduct.total_stock,
            "total awaiting": currentProduct.totalAwaitingInventory,
            "Color": "",
            "OH size 2": 0,
            "OH size 2.5": 0,
            "OH size 3": 0,
            "OH size 3.5": 0,
            "OH size 4": 0,
            "OH size 4.5": 0,
            "OH size 5": 0,
            "OH size 6.5": 0,
            "OH size 6": 0,
            "OH size 7": 0,
            "OH size 7.5": 0,
            "OH size 8": 0,
            "OH size 8.5": 0,
            "OH size 9": 0,
            "OH size 9.5": 0,
            "OH size 10": 0,
            "OH size 10.5": 0,
            "OH size 11": 0,
            "awating size 2": 0,
            "awating size 2.5": 0,
            "awating size 3": 0,
            "awating size 3.5": 0,
            "awating size 4": 0,
            "awating size 4.5": 0,
            "awating size 5": 0,
            "awating size 6.5": 0,
            "awating size 6": 0,
            "awating size 7": 0,
            "awating size 7.5": 0,
            "awating size 8": 0,
            "awating size 8.5": 0,
            "awating size 9": 0,
            "awating size 9.5": 0,
            "awating size 10": 0,
            "awating size 10.5": 0,
            "awating size 11": 0,
          };
  
          // Loop variants to know sizes
          if(typeof currentProduct.variants !== 'undefined')
            currentProduct.variants.map(variant => {
              var oh = `OH size ${variant.size_value}`;
              var awaiting = `awating size ${variant.totalAwaitingInventory}`;
  
              if (variant.inventoryLevel !== null && typeof variant.inventoryLevel !== 'undefined')
                currentRow[oh] =+ variant.inventoryLevel;
              if (variant.totalAwaitingInventory !== null && typeof variant.totalAwaitingInventory !== 'undefined')
                currentRow[awaiting] =+ variant.totalAwaitingInventory;
            });
  
          csvRows.push(currentRow);
          return csvRows;
        }, []);

        resolve({ fields, productsRows });
      });
    }

    var filters = {
      includes: ["designer", "classification", "variants", "variants.colorCode"],
      limit: 1000,
    };

    return ProductsModel.getProductsByFilters(filters)
      .then(parseToCSVRows)
      .then(createCSV)

  } // End getProductsAsCSV


}