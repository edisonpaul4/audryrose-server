var path = require('path');
var fs = require('fs');
var streams = require('memory-streams');
var json2csv = require('json2csv');
var moment = require('moment');

var { ProductsModel } = require('./products.model');
var { OrdersController } = require('../orders/orders.controller');

exports.ProductsController = new class ProductsController {
  constructor(){ 
    this.ProductsCSV = new Parse.Object.extend('ProductsCSV');
  }

  /**
   * @param productId<number>
   * @returns Promise<number> - Need to order for products
   */
  calculateNeedToOrder(productId){      
    var getProductOrders = productId => OrdersController.getOrdersForProduct(productId, {
      greaterOrEqual: [
        { key: 'createdAt', value: moment().subtract(75, 'days').toDate()}
      ],
      count: true
    });

    var getProduct = productId => ProductsModel.getProductsByFilters({
      equal: [
        { key: 'productId', value: productId }
      ]
    }).first();

    return Promise.all([
      getProductOrders(productId),
      getProduct(productId)
    ]).then(values => {
        const totalOrders = values[0];
        const product = values[1];
        
        var needToOrderCalc = (totalOrders * .8) - product.get('total_stock') - product.get('totalAwaitingInventory');
        return needToOrderCalc > 0 && product.get('is_active') ? Math.round(needToOrderCalc) : 0;
      });
  }

  /**
   * @returns CSV File url
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

        var fields = ["Dated Added", "Bigcommerce SKU", "Audry Rose Name", "Designer Name", "Designer", "Retail Price", "Wholesale Price", "Class", "Size Scale", "Status ", "Act OH", "Total awaiting", "Color", "OH size 2", "OH size 2.5", "OH size 3", "OH size 3.5", "OH size 4", "OH size 4.5", "OH size 5", "OH size 6.5", "OH size 6", "OH size 7", "OH size 7.5", "OH size 8", "OH size 8.5", "OH size 9", "OH size 9.5", "OH size 10", "OH size 10.5", "OH size 11", "awating size 2", "awating size 2.5", "awating size 3", "awating size 3.5", "awating size 4", "awating size 4.5", "awating size 5", "awating size 6.5", "awating size 6", "awating size 7", "awating size 7.5", "awating size 8", "awating size 8.5", "awating size 9", "awating size 9.5", "awating size 10", "awating size 10.5", "awating size 11"];

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
            "Status ": currentProduct.availability,
            "Act OH": currentProduct.total_stock,
            "Total awaiting": currentProduct.totalAwaitingInventory,
          };

          // Loop if has variants
          if(typeof currentProduct.variants !== 'undefined'){
            var variantsRows = [];
            currentProduct.variants.map(variant => {
              var index = variantsRows.findIndex(v => v["Color"] == variant.color_label);

              if (index === -1) {
                variantsRows.push({
                  ...currentRow,
                  "Color": variant.color_label,
                  "Total awaiting": 0,
                  "Act OH": 0
                });
                index = variantsRows.findIndex(v => v["Color"] == variant.color_label);
              }

              var variantRow = index !== -1 ? variantsRows[index] : { ...currentRow };
              var oh = `OH size ${variant.size_value}`;
              var awaiting = `awating size ${variant.size_value}`;

              variantRow['Color'] = variant.color_label;

              if (variant.totalAwaitingInventory !== null && typeof variant.totalAwaitingInventory !== 'undefined') {
                variantRow['Total awaiting'] = variantRow['Total awaiting'] + variant.totalAwaitingInventory;
                variantRow[awaiting] = variant.totalAwaitingInventory;
              }

              if (variant.inventoryLevel !== null && typeof variant.inventoryLevel !== 'undefined') {
                variantRow['Act OH'] = variantRow['Act OH'] + variant.inventoryLevel;
                variantRow[oh] = variant.inventoryLevel;
              }
            });
            csvRows = [...csvRows, ...variantsRows];
          } else {
            csvRows.push(currentRow);
          }
          
          return csvRows;
        }, []);

        resolve({ fields, productsRows });
      });
    }

    var filters = {
      includes: ["designer", "classification", "variants", "variants.colorCode"],
      limit: 1000,
      notEqual: [
        { key: 'isBundle', value: true },
      ],
      json: true
    };

    return ProductsModel.getProductsByFilters(filters)
      .then(parseToCSVRows)
      .then(createCSV)

  } // End getProductsAsCSV
  
}