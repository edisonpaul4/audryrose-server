var { BaseModel } = require('../database/base.model');

exports.ProductsModel = new class ProductsModel extends BaseModel {
  constructor(){
    super();
    this.Products = Parse.Object.extend('Product');
  }

  /**
   * @returns Promise - Array of objects
   * @param base query params
   */
  getProductsByFilters(params) {
    var productsQuery = new Parse.Query(this.Products);
    return this.searchDatabase(params, productsQuery);
  }  
}