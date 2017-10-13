exports.ProductsModel = new class ProductsModel {
  constructor(){
    this.Products = Parse.Object.extend('Product');
  }

  /**
   * @returns Promise - Array of objects
   * @param {*} param0
   */
  getProductsByFilters({ includes, page, limit, sort, skip }) {
    var productsQuery = new Parse.Query(this.Products);
    if (includes.length > 0 && includes !== null && typeof includes !== 'undefined')
      includes.map(include => productsQuery.include(include));

    if(limit === null || typeof limit === 'undefined' )
      limit = 100;

    if(skip === null || typeof skip === 'undefined' )
      skip = 0;
      
    return productsQuery
      .limit(limit)
      .skip(skip)
      .find()
      .then(objects => objects.map(object => object.toJSON()));
  }  
}